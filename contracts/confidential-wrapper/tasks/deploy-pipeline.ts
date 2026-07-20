import { CONTRACT_NAME, getConfidentialWrapperProxyName } from './deploy';
import { getVersion, Manifest } from '@openzeppelin/upgrades-core';
import { execSync } from 'child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { task, types } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { resolve } from 'path';

// These CI tasks wrap the existing deploy/verify tasks with the validation,
// idempotency guards and structured reporting the GitHub Actions deploy
// workflow needs. All path/JSON handling lives here (in Node) rather than in
// the workflow shell because deployment artifact names contain spaces and
// parentheses.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES4_RE = /^0x[0-9a-fA-F]{8}$/;

// Fields mirror ConfidentialWrapperInitConfig in ./deploy.ts
type WrapperParams = {
  name: string;
  symbol: string;
  contractUri: string;
  underlying: string;
  owner: string;
  blockedUsers: string[];
  underlyingDenyListSelector: string;
  hasUnderlyingDenyListSelector: boolean;
};

type NetworkConfig = {
  chainId: number;
  ozManifest: string;
  dao: string;
  registry: string;
  minDeployerBalanceWei: string;
};

// Minimal registry ABI — only what the reporter needs.
const REGISTRY_ABI = [
  'function isConfidentialTokenValid(address confidentialToken) view returns (bool)',
  'function registerConfidentialToken(address token, address confidentialToken)',
];

function readJsonFile<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${path}: ${(err as Error).message}`);
  }
}

// networks.json lives next to this file's deploy-params dir, resolved relative
// to the task file so the cwd doesn't matter.
function loadNetworkConfig(hre: HardhatRuntimeEnvironment): NetworkConfig {
  const networks = readJsonFile<Record<string, NetworkConfig>>(resolve(__dirname, '../deploy-params/networks.json'));
  const config = networks[hre.network.name];
  if (!config) {
    throw new Error(
      `No entry for network "${hre.network.name}" in deploy-params/networks.json (have: ${Object.keys(networks).join(', ')})`,
    );
  }
  return config;
}

function assertAddress(hre: HardhatRuntimeEnvironment, value: unknown, field: string): void {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new Error(`${field} must be a 0x-prefixed 20-byte address, got: ${JSON.stringify(value)}`);
  }
  try {
    hre.ethers.getAddress(value);
  } catch {
    throw new Error(`${field} has an invalid EIP-55 checksum: ${value}`);
  }
}

// Validate a params file against the wrapper init schema. Throws on any problem
// (params are unusable if malformed — there is no partial deploy).
function loadAndValidateParams(hre: HardhatRuntimeEnvironment, paramsFile: string): WrapperParams {
  const p = readJsonFile<WrapperParams>(resolve(paramsFile));

  if (typeof p.name !== 'string' || p.name.length === 0) throw new Error('name must be a non-empty string');
  if (typeof p.symbol !== 'string' || p.symbol.length === 0) throw new Error('symbol must be a non-empty string');
  if (typeof p.contractUri !== 'string' || p.contractUri.length === 0)
    throw new Error('contractUri must be a non-empty string');
  assertAddress(hre, p.underlying, 'underlying');
  assertAddress(hre, p.owner, 'owner');
  if (!Array.isArray(p.blockedUsers)) throw new Error('blockedUsers must be an array');
  p.blockedUsers.forEach((addr, i) => assertAddress(hre, addr, `blockedUsers[${i}]`));
  if (typeof p.underlyingDenyListSelector !== 'string' || !BYTES4_RE.test(p.underlyingDenyListSelector))
    throw new Error(`underlyingDenyListSelector must be a 0x-prefixed bytes4, got: ${p.underlyingDenyListSelector}`);
  if (typeof p.hasUnderlyingDenyListSelector !== 'boolean')
    throw new Error('hasUnderlyingDenyListSelector must be a boolean');

  return p;
}

function currentGitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

// Report whether the current implementation source will be reused from the OZ
// manifest or freshly deployed. Best-effort and never throws — the definitive
// decision is made by deployProxy at broadcast time.
async function reportImplReuse(hre: HardhatRuntimeEnvironment): Promise<string> {
  try {
    const factory = await hre.ethers.getContractFactory(CONTRACT_NAME);
    const bytecode = factory.bytecode;
    const version = getVersion(bytecode, bytecode);
    // Use the EIP-1193 network provider, matching the OZ upgrades plugin.
    const manifest = await Manifest.forNetwork(hre.network.provider);
    const data = await manifest.read();
    const existing = data.impls[version.linkedWithoutMetadata];
    if (existing?.address) {
      return `reuse existing implementation ${existing.address} from the OZ manifest`;
    }
    return 'deploy a fresh implementation (no matching entry in the OZ manifest)';
  } catch (err) {
    return `could not determine (will be decided at deploy time): ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// task:preflightConfidentialWrapper
// Read-only validation gate run before broadcasting a deploy. FORCE_REDEPLOY=true
// bypasses only the existing-proxy guard.
// ---------------------------------------------------------------------------
task('task:preflightConfidentialWrapper')
  .addParam('paramsFile', 'Path to the wrapper params JSON file', undefined, types.string)
  .addParam('deployerAddress', 'The resolved deployer address (public info)', undefined, types.string)
  .setAction(async function ({ paramsFile, deployerAddress }, hre) {
    const { ethers, deployments } = hre;
    const forceRedeploy = process.env.FORCE_REDEPLOY === 'true';

    // Schema validation is fatal — nothing else can run against bad params.
    const params = loadAndValidateParams(hre, paramsFile);
    assertAddress(hre, deployerAddress, 'deployerAddress');
    const networkConfig = loadNetworkConfig(hre);

    const failures: string[] = [];
    const lines: string[] = [`Preflight for "${params.name}" (${params.symbol}) on ${hre.network.name}:`];

    // Owner MUST be the network DAO — a wrong owner breaks governance execution
    // and there is no CI escape hatch (exceptional deploys use the manual runbook).
    if (ethers.getAddress(params.owner) !== ethers.getAddress(networkConfig.dao)) {
      failures.push(`owner ${params.owner} !== network DAO ${networkConfig.dao} (owner must be the DAO)`);
    } else {
      lines.push(`  ✓ owner is the network DAO (${networkConfig.dao})`);
    }

    // RPC chain id matches the expected chain for this network.
    const actualChainId = Number((await ethers.provider.getNetwork()).chainId);
    if (actualChainId !== networkConfig.chainId) {
      failures.push(`RPC chainId ${actualChainId} !== expected ${networkConfig.chainId} for ${hre.network.name}`);
    } else {
      lines.push(`  ✓ RPC chainId ${actualChainId}`);
    }

    // Underlying must be a deployed contract.
    const code = await ethers.provider.getCode(params.underlying);
    if (code === '0x' || code === '0x0') {
      failures.push(`underlying ${params.underlying} has no bytecode on ${hre.network.name}`);
    } else {
      lines.push(`  ✓ underlying ${params.underlying} has bytecode`);
    }

    // Deployer balance above the configured threshold.
    const balance = await ethers.provider.getBalance(deployerAddress);
    const threshold = BigInt(networkConfig.minDeployerBalanceWei);
    if (balance < threshold) {
      failures.push(
        `deployer ${deployerAddress} balance ${ethers.formatEther(balance)} ETH < min ${ethers.formatEther(threshold)} ETH`,
      );
    } else {
      lines.push(`  ✓ deployer balance ${ethers.formatEther(balance)} ETH ≥ ${ethers.formatEther(threshold)} ETH`);
    }

    // Proxy-redeploy guard: refuse to re-deploy an existing proxy name unless forced.
    const proxyName = getConfidentialWrapperProxyName(params.name);
    const existingProxy = await deployments.getOrNull(proxyName);
    if (existingProxy && !forceRedeploy) {
      failures.push(
        `proxy "${proxyName}" already deployed at ${existingProxy.address}; set force_redeploy=true to deploy a new proxy`,
      );
    } else if (existingProxy && forceRedeploy) {
      lines.push(`  ! proxy "${proxyName}" exists at ${existingProxy.address} — FORCE_REDEPLOY set, will deploy anew`);
    } else {
      lines.push(`  ✓ no existing proxy named "${proxyName}"`);
    }

    // No-broadcast implementation validation (UUPS).
    try {
      const factory = await ethers.getContractFactory(CONTRACT_NAME);
      await hre.upgrades.validateImplementation(factory, { kind: 'uups' });
      lines.push('  ✓ implementation passes UUPS upgrade-safety validation');
    } catch (err) {
      failures.push(`implementation failed upgrade-safety validation: ${(err as Error).message}`);
    }

    lines.push(`  • implementation plan: ${await reportImplReuse(hre)}`);

    console.log(lines.join('\n'));

    if (failures.length > 0) {
      throw new Error(`Preflight failed:\n${failures.map(f => `  ✗ ${f}`).join('\n')}`);
    }
    console.log('\n✅ Preflight passed');
  });

// ---------------------------------------------------------------------------
// task:deployConfidentialWrapperFromParams
// Thin wrapper: parse+validate the params file, delegate to the existing
// task:deployConfidentialWrapper. No new deploy logic.
// ---------------------------------------------------------------------------
task('task:deployConfidentialWrapperFromParams')
  .addParam('paramsFile', 'Path to the wrapper params JSON file', undefined, types.string)
  .setAction(async function ({ paramsFile }, hre) {
    const params = loadAndValidateParams(hre, paramsFile);
    await hre.run('task:deployConfidentialWrapper', {
      name: params.name,
      symbol: params.symbol,
      contractUri: params.contractUri,
      underlying: params.underlying,
      owner: params.owner,
      blockedUsers: params.blockedUsers,
      underlyingDenyListSelector: params.underlyingDenyListSelector,
      hasUnderlyingDenyListSelector: params.hasUnderlyingDenyListSelector,
    });
  });

// ---------------------------------------------------------------------------
// task:reportConfidentialWrapper
// Tolerant post-deploy reporter — safe under `if: always()`. Writes structured
// JSON to --out and a markdown block to $GITHUB_STEP_SUMMARY. Only exits nonzero
// on a mismatch when --strict is passed.
// ---------------------------------------------------------------------------
task('task:reportConfidentialWrapper')
  .addParam('paramsFile', 'Path to the wrapper params JSON file', undefined, types.string)
  .addParam('out', 'Path to write the structured deploy-log JSON', 'deploy-log.json', types.string)
  .addFlag('strict', 'Exit nonzero if any post-deploy check mismatches')
  .setAction(async function ({ paramsFile, out, strict }, hre) {
    const { ethers, deployments, upgrades } = hre;
    const params = loadAndValidateParams(hre, paramsFile);
    const networkConfig = loadNetworkConfig(hre);

    const checks: { name: string; expected: unknown; actual: unknown; ok: boolean }[] = [];
    const record = (name: string, expected: unknown, actual: unknown) =>
      checks.push({ name, expected, actual, ok: String(expected).toLowerCase() === String(actual).toLowerCase() });

    const proxyName = getConfidentialWrapperProxyName(params.name);
    const proxyDeployment = await deployments.getOrNull(proxyName);

    const log: Record<string, unknown> = {
      network: hre.network.name,
      chainId: networkConfig.chainId,
      wrapper: { name: params.name, symbol: params.symbol },
      deployed: Boolean(proxyDeployment),
      gitSha: currentGitSha(),
      timestamp: new Date().toISOString(),
    };

    const summary: string[] = [`## Confidential Wrapper deploy — ${params.name} (${params.symbol})`, ''];
    summary.push(`- **Network:** ${hre.network.name} (chainId ${networkConfig.chainId})`);

    if (!proxyDeployment) {
      // Not-deployed → report state without throwing.
      summary.push(`- **Status:** ⚠️ proxy "${proxyName}" not found in deployments — nothing deployed`);
      log.checks = [];
      writeOutputs(hre, out, log, summary);
      console.log(`Proxy "${proxyName}" not deployed; wrote state-only report to ${out}`);
      return;
    }

    const proxyAddress = proxyDeployment.address;
    let implAddress = 'unknown';
    try {
      implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    } catch (err) {
      summary.push(`- ⚠️ could not read implementation address: ${(err as Error).message}`);
    }

    // Read on-chain state from the proxy, tolerating reverts.
    const proxy = await ethers.getContractAt(CONTRACT_NAME, proxyAddress);
    const safeCall = async (label: string, fn: () => Promise<unknown>): Promise<unknown> => {
      try {
        return await fn();
      } catch (err) {
        summary.push(`- ⚠️ ${label}() reverted: ${(err as Error).message}`);
        return `<error: ${(err as Error).message}>`;
      }
    };
    record('name', params.name, await safeCall('name', () => proxy.name()));
    record('symbol', params.symbol, await safeCall('symbol', () => proxy.symbol()));
    record('underlying', params.underlying, await safeCall('underlying', () => proxy.underlying()));
    record('owner', params.owner, await safeCall('owner', () => proxy.owner()));

    // Ready-made DAO registration payload: registerConfidentialToken(underlying, proxy).
    const registrationCalldata = new ethers.Interface(REGISTRY_ABI).encodeFunctionData('registerConfidentialToken', [
      params.underlying,
      proxyAddress,
    ]);
    const castCommand = `cast calldata "registerConfidentialToken(address,address)" ${params.underlying} ${proxyAddress}`;

    log.addresses = { proxy: proxyAddress, implementation: implAddress, underlying: params.underlying };
    log.checks = checks;
    log.registration = { target: networkConfig.registry, calldata: registrationCalldata, cast: castCommand };

    summary.push(`- **Proxy:** \`${proxyAddress}\``);
    summary.push(`- **Implementation:** \`${implAddress}\``);
    summary.push(`- **Underlying:** \`${params.underlying}\``);
    summary.push('');
    summary.push('| Check | Expected | Actual | OK |');
    summary.push('| --- | --- | --- | --- |');
    for (const c of checks) {
      summary.push(`| ${c.name} | \`${c.expected}\` | \`${c.actual}\` | ${c.ok ? '✅' : '❌'} |`);
    }
    summary.push('');
    summary.push('### DAO registration payload');
    summary.push(`Target: \`${networkConfig.registry}\``);
    summary.push('');
    summary.push('```');
    summary.push(`calldata: ${registrationCalldata}`);
    summary.push(castCommand);
    summary.push('```');

    writeOutputs(hre, out, log, summary);

    const mismatches = checks.filter(c => !c.ok);
    console.log(`Wrote deploy-log to ${out}. ${mismatches.length} mismatch(es).`);
    if (strict && mismatches.length > 0) {
      throw new Error(
        `Post-deploy checks failed:\n${mismatches.map(c => `  ✗ ${c.name}: expected ${c.expected}, got ${c.actual}`).join('\n')}`,
      );
    }
  });

function writeOutputs(
  hre: HardhatRuntimeEnvironment,
  out: string,
  log: Record<string, unknown>,
  summary: string[],
): void {
  writeFileSync(resolve(out), JSON.stringify(log, null, 2));
  const summaryText = summary.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText);
  }
  console.log(summaryText);
}
