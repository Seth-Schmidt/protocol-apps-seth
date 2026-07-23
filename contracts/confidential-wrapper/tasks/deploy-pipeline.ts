import { CONTRACT_NAME, getConfidentialWrapperProxyName, resolveDeployerAddress } from './deploy';
import { findWrapperByUnderlying, loadNetworkConfig } from './utils/deployParams';
import { getVersion, Manifest } from '@openzeppelin/upgrades-core';
import { execSync } from 'child_process';
import { appendFileSync, writeFileSync } from 'fs';
import { task, types } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { resolve } from 'path';

// CI tasks that wrap the deploy/verify tasks with validation, idempotency guards and
// structured reporting. Path/JSON handling lives here (not the workflow shell) because
// artifact names contain spaces and parentheses.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES4_RE = /^0x[0-9a-fA-F]{8}$/;

// A wrapper entry in deploy-params/<tier>/<network>/wrappers.json, keyed by the wrapper symbol
// (e.g. `cUSDT`) so the file is self-documenting. `underlying` is the wrapped token address.
// owner/name/contractUri are optional: owner defaults to the network DAO, name/contractUri to
// the underlying's on-chain metadata (see resolveWrapperParams).
type WrapperEntry = {
  underlying: string;
  name?: string;
  contractUri?: string;
  owner?: string;
  blockedUsers: string[];
  underlyingDenyListSelector: string;
  hasUnderlyingDenyListSelector: boolean;
};

// Fully-resolved wrapper params (all defaults filled in), ready for the deploy task.
// Mirrors ConfidentialWrapperInitConfig in ./deploy.ts.
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

// Minimal registry ABI. getConfidentialTokenAddress(token) → (isValid, confidentialToken):
// (false, 0x0) never registered, (true, wrapper) valid, (false, wrapper) revoked.
const REGISTRY_ABI = [
  'function getConfidentialTokenAddress(address token) view returns (bool isValid, address confidentialToken)',
  'function isConfidentialTokenValid(address confidentialToken) view returns (bool)',
  'function registerConfidentialToken(address token, address confidentialToken)',
];

// ERC-20 metadata ABI, used to derive default name/symbol from the underlying.
const ERC20_METADATA_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];

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

// Load and validate the wrapper entry for `underlying` from deploy-params/<tier>/<network>/
// wrappers.json. Lookup is checksum-insensitive (see findWrapperByUnderlying); full field
// validation happens here. Optional name/contractUri are validated only when present.
function loadWrapperEntry(
  hre: HardhatRuntimeEnvironment,
  underlying: string,
): WrapperEntry & { symbol: string } {
  assertAddress(hre, underlying, 'underlying');
  const target = hre.ethers.getAddress(underlying);

  const { symbol, entry: raw, paramsFile } = findWrapperByUnderlying(hre.network.name, underlying);

  let entryUnderlying: string;
  try {
    entryUnderlying = hre.ethers.getAddress(raw.underlying);
  } catch {
    throw new Error(`Entry "${symbol}" in ${paramsFile} has an invalid underlying address "${raw.underlying}"`);
  }
  if (entryUnderlying !== target) {
    throw new Error(`Entry "${symbol}" in ${paramsFile} underlying mismatch after checksum normalize`);
  }

  const entry = raw as WrapperEntry;

  // Required fields.
  if (!Array.isArray(entry.blockedUsers)) throw new Error('blockedUsers must be an array');
  entry.blockedUsers.forEach((addr, i) => assertAddress(hre, addr, `blockedUsers[${i}]`));
  if (typeof entry.underlyingDenyListSelector !== 'string' || !BYTES4_RE.test(entry.underlyingDenyListSelector))
    throw new Error(`underlyingDenyListSelector must be a 0x-prefixed bytes4, got: ${entry.underlyingDenyListSelector}`);
  if (typeof entry.hasUnderlyingDenyListSelector !== 'boolean')
    throw new Error('hasUnderlyingDenyListSelector must be a boolean');

  // Optional fields: validated only when present (otherwise defaulted). owner → network DAO;
  // name/contractUri → on-chain metadata.
  if (entry.owner !== undefined) assertAddress(hre, entry.owner, 'owner');
  if (entry.name !== undefined && (typeof entry.name !== 'string' || entry.name.length === 0))
    throw new Error('name, when set, must be a non-empty string');
  if (entry.contractUri !== undefined && (typeof entry.contractUri !== 'string' || entry.contractUri.length === 0))
    throw new Error('contractUri, when set, must be a non-empty string');

  return { ...entry, underlying: target, symbol };
}

// Read the underlying's name()/symbol() to default an entry's name/contractUri. Throws a helpful
// error for non-standard tokens (e.g. bytes32 metadata); the operator can set name/contractUri instead.
async function readUnderlyingMetadata(
  hre: HardhatRuntimeEnvironment,
  underlying: string,
): Promise<{ name: string; symbol: string }> {
  try {
    const token = new hre.ethers.Contract(underlying, ERC20_METADATA_ABI, hre.ethers.provider);
    const [name, symbol] = await Promise.all([token.name(), token.symbol()]);
    return { name, symbol };
  } catch (err) {
    throw new Error(
      `Could not read name()/symbol() from underlying ${underlying} on ${hre.network.name} ` +
        `(${(err as Error).message}). Set name and contractUri explicitly in deploy-params/<tier>/<network>/wrappers.json.`,
    );
  }
}

// Build the default contractUri metadata blob from the resolved name/symbol. Wording matches the
// live deployments so committed entries can omit contractUri.
function defaultContractUri(name: string, symbol: string, underlyingSymbol: string): string {
  const metadata = JSON.stringify({
    name,
    symbol,
    description: `Confidential wrapper of ${underlyingSymbol} shielding it into a confidential token`,
  });
  return `data:application/json;utf8,${metadata}`;
}

// Resolve an entry into fully-populated params. The symbol is the entry key; owner defaults to
// the network DAO and name/contractUri to the underlying's on-chain metadata when omitted. Only
// touches RPC for a default.
async function resolveWrapperParams(hre: HardhatRuntimeEnvironment, underlying: string): Promise<WrapperParams> {
  const entry = loadWrapperEntry(hre, underlying);
  const symbol = entry.symbol;
  const owner = entry.owner ? hre.ethers.getAddress(entry.owner) : loadNetworkConfig(hre.network.name).dao;
  let { name, contractUri } = entry;
  if (name === undefined || contractUri === undefined) {
    const meta = await readUnderlyingMetadata(hre, entry.underlying);
    // Wrappers are named `Confidential <underlying symbol>` (e.g. USDC → "Confidential USDC"),
    // matching the live deployments — not the underlying's longer name() ("USD Coin").
    if (name === undefined) name = `Confidential ${meta.symbol}`;
    if (contractUri === undefined) contractUri = defaultContractUri(name, symbol, meta.symbol);
  }
  return {
    name,
    symbol,
    contractUri,
    underlying: entry.underlying,
    owner,
    blockedUsers: entry.blockedUsers,
    underlyingDenyListSelector: entry.underlyingDenyListSelector,
    hasUnderlyingDenyListSelector: entry.hasUnderlyingDenyListSelector,
  };
}

function currentGitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

// Report whether the implementation will be reused from the OZ manifest or freshly deployed.
// Best-effort and never throws — deployProxy makes the definitive call at broadcast time.
async function reportImplReuse(hre: HardhatRuntimeEnvironment): Promise<string> {
  try {
    const factory = await hre.ethers.getContractFactory(CONTRACT_NAME);
    const bytecode = factory.bytecode;
    const version = getVersion(bytecode, bytecode);
    // EIP-1193 network provider, matching the OZ upgrades plugin.
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

// task:printDeployerAddress — print the deployer address (DFNS wallet or local key). No RPC call;
// writes `address=<addr>` to $GITHUB_OUTPUT so the workflow captures it regardless of stdout.
task('task:printDeployerAddress').setAction(async function (_, hre) {
  const address = await resolveDeployerAddress(hre);
  console.log(`Deployer address: ${address}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `address=${address}\n`);
  }
});

// task:checkParamsEntry — fail-fast CI preflight: wrappers.json must have a matching underlying.
// Writes `symbol=<key>` to $GITHUB_OUTPUT for the state PR title/commit. No RPC.
task('task:checkParamsEntry')
  .addParam('underlying', 'Underlying ERC-20 address; selects the entry in deploy-params/<tier>/<network>/wrappers.json', undefined, types.string)
  .setAction(async function ({ underlying }, hre) {
    try {
      const { symbol, entry, paramsFile } = findWrapperByUnderlying(hre.network.name, underlying);
      console.log(`Using ${paramsFile} → ${symbol} (${entry.underlying})`);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `symbol=${symbol}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`::error::${msg}`);
      throw err;
    }
  });

// task:preflightConfidentialWrapper — read-only validation gate run before broadcasting.
task('task:preflightConfidentialWrapper')
  .addParam('underlying', 'Underlying ERC-20 address; selects the entry in deploy-params/<tier>/<network>/wrappers.json', undefined, types.string)
  .addParam('deployerAddress', 'The resolved deployer address (public info)', undefined, types.string)
  .setAction(async function ({ underlying, deployerAddress }, hre) {
    const { ethers, deployments } = hre;

    // Fatal: nothing else can run against bad params.
    const params = await resolveWrapperParams(hre, underlying);
    assertAddress(hre, deployerAddress, 'deployerAddress');
    const networkConfig = loadNetworkConfig(hre.network.name);

    const failures: string[] = [];
    const lines: string[] = [`Preflight for "${params.name}" (${params.symbol}) on ${hre.network.name}:`];

    // Owner defaults to the network DAO (the correct owner for governance execution). An explicit
    // per-entry override is allowed but flagged loudly — a non-DAO owner is almost always a mistake.
    if (ethers.getAddress(params.owner) === ethers.getAddress(networkConfig.dao)) {
      lines.push(`  ✓ owner is the network DAO (${networkConfig.dao})`);
    } else {
      lines.push(`  ! owner ${params.owner} is an explicit override (NOT the network DAO ${networkConfig.dao})`);
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

    // Proxy-redeploy guard: refuse to re-deploy an existing proxy name. A genuine redeploy is
    // exceptional and must use the manual runbook, not CI.
    const proxyName = getConfidentialWrapperProxyName(params.symbol);
    const existingProxy = await deployments.getOrNull(proxyName);
    if (existingProxy) {
      failures.push(
        `proxy "${proxyName}" already deployed at ${existingProxy.address}; a genuine redeploy must use the manual runbook`,
      );
    } else {
      lines.push(`  ✓ no existing proxy named "${proxyName}"`);
    }

    // Registry dedup (authoritative, keyed by underlying): one wrapper per token, revocation is
    // permanent. Hard fail — a second proxy could never be registered. Exceptional cases use the
    // manual runbook.
    try {
      const registry = new ethers.Contract(networkConfig.registry, REGISTRY_ABI, ethers.provider);
      const [isValid, registered] = await registry.getConfidentialTokenAddress(params.underlying);
      if (registered && registered !== ethers.ZeroAddress) {
        failures.push(
          `underlying ${params.underlying} already has a confidential wrapper ${registered} in the registry ` +
            `(${isValid ? 'valid' : 'revoked'}); a token may have only one wrapper — refusing to deploy another`,
        );
      } else {
        lines.push(`  ✓ registry has no confidential wrapper for underlying ${params.underlying}`);
      }
    } catch (err) {
      failures.push(`could not query registry ${networkConfig.registry} for underlying ${params.underlying}: ${(err as Error).message}`);
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

// task:deployConfidentialWrapperFromParams — resolve the entry (filling defaults), delegate to
// task:deployConfidentialWrapper, and emit the proxy address to $GITHUB_OUTPUT so downstream
// steps need not reconstruct the artifact name. No new deploy logic.
task('task:deployConfidentialWrapperFromParams')
  .addParam('underlying', 'Underlying ERC-20 address; selects the entry in deploy-params/<tier>/<network>/wrappers.json', undefined, types.string)
  .setAction(async function ({ underlying }, hre) {
    const params = await resolveWrapperParams(hre, underlying);
    const proxyAddress: string = await hre.run('task:deployConfidentialWrapper', {
      name: params.name,
      symbol: params.symbol,
      contractUri: params.contractUri,
      underlying: params.underlying,
      owner: params.owner,
      blockedUsers: params.blockedUsers,
      underlyingDenyListSelector: params.underlyingDenyListSelector,
      hasUnderlyingDenyListSelector: params.hasUnderlyingDenyListSelector,
    });
    if (process.env.GITHUB_OUTPUT && proxyAddress) {
      appendFileSync(process.env.GITHUB_OUTPUT, `proxy=${proxyAddress}\n`);
    }
  });

// task:reportConfidentialWrapper — tolerant post-deploy reporter, safe under `if: always()`.
// Writes JSON to --out and a markdown block to $GITHUB_STEP_SUMMARY. Exits nonzero on a
// mismatch only with --strict.
task('task:reportConfidentialWrapper')
  .addParam('underlying', 'Underlying ERC-20 address; selects the entry in deploy-params/<tier>/<network>/wrappers.json', undefined, types.string)
  .addParam('out', 'Path to write the structured deploy-log JSON', 'deploy-log.json', types.string)
  .addFlag('strict', 'Exit nonzero if any post-deploy check mismatches')
  .setAction(async function ({ underlying, out, strict }, hre) {
    const { ethers, deployments, upgrades } = hre;
    const params = await resolveWrapperParams(hre, underlying);
    const networkConfig = loadNetworkConfig(hre.network.name);

    const checks: { name: string; expected: unknown; actual: unknown; ok: boolean }[] = [];
    const record = (name: string, expected: unknown, actual: unknown) =>
      checks.push({ name, expected, actual, ok: String(expected).toLowerCase() === String(actual).toLowerCase() });

    const proxyName = getConfidentialWrapperProxyName(params.symbol);
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

    // Current on-chain registration status, keyed by underlying. Tolerant — never throws.
    let registrationStatus: { registered: boolean; isValid: boolean; wrapper: string; matchesProxy: boolean } | null =
      null;
    try {
      const registry = new ethers.Contract(networkConfig.registry, REGISTRY_ABI, ethers.provider);
      const [isValid, wrapper] = await registry.getConfidentialTokenAddress(params.underlying);
      const registered = Boolean(wrapper) && wrapper !== ethers.ZeroAddress;
      registrationStatus = {
        registered,
        isValid: Boolean(isValid),
        wrapper: registered ? ethers.getAddress(wrapper) : ethers.ZeroAddress,
        matchesProxy: registered && ethers.getAddress(wrapper) === ethers.getAddress(proxyAddress),
      };
    } catch (err) {
      summary.push(`- ⚠️ registry getConfidentialTokenAddress reverted: ${(err as Error).message}`);
    }

    // Ready-made DAO registration payload: registerConfidentialToken(underlying, proxy).
    const registrationCalldata = new ethers.Interface(REGISTRY_ABI).encodeFunctionData('registerConfidentialToken', [
      params.underlying,
      proxyAddress,
    ]);
    const castCommand = `cast calldata "registerConfidentialToken(address,address)" ${params.underlying} ${proxyAddress}`;

    log.addresses = { proxy: proxyAddress, implementation: implAddress, underlying: params.underlying };
    log.checks = checks;
    log.registration = {
      target: networkConfig.registry,
      calldata: registrationCalldata,
      cast: castCommand,
      status: registrationStatus,
    };

    const registrationSummary = !registrationStatus
      ? '⚠️ could not read registry'
      : !registrationStatus.registered
        ? '⏳ not registered yet — submit the calldata below via the DAO'
        : registrationStatus.matchesProxy
          ? registrationStatus.isValid
            ? '✅ registered & valid'
            : '⚠️ registered but revoked (revocation is permanent)'
          : `⚠️ underlying registered to a DIFFERENT wrapper ${registrationStatus.wrapper}`;

    summary.push(`- **Proxy:** \`${proxyAddress}\``);
    summary.push(`- **Implementation:** \`${implAddress}\``);
    summary.push(`- **Underlying:** \`${params.underlying}\``);
    summary.push(`- **Registry status:** ${registrationSummary}`);
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
