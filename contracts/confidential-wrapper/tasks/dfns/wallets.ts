/**
 * Resolve the DFNS deployer wallet for the active Hardhat network.
 *
 * Unlike confidential-defi (which keeps per-role wallet ids in GitHub secrets), the
 * wallet id here is a NON-SENSITIVE opaque identifier that maps to a public chain
 * address, so it lives in committed config (`deploy-params/networks.json`, field
 * `dfnsDeployerWalletId`) and needs no secret / repo-admin privilege to set. Only
 * the DFNS auth credentials (see `auth.ts`) are secrets.
 */
import { dfnsApiClient, type DfnsAuthConfig } from './auth';
import { getAddress } from 'ethers';
import { existsSync, readFileSync } from 'fs';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { resolve } from 'path';

// networks.json lives under deploy-params/, resolved relative to this file so the
// cwd doesn't matter. Mirrors the path logic in tasks/deploy-pipeline.ts.
const NETWORKS_JSON = resolve(__dirname, '../../deploy-params/networks.json');

type NetworkEntry = { chainId: number; dfnsDeployerWalletId?: string };

function readNetworkEntry(networkName: string): NetworkEntry {
  if (!existsSync(NETWORKS_JSON)) {
    throw new Error(`File not found: ${NETWORKS_JSON}`);
  }
  const networks = JSON.parse(readFileSync(NETWORKS_JSON, 'utf8')) as Record<string, NetworkEntry>;
  const entry = networks[networkName];
  if (!entry) {
    throw new Error(
      `No entry for network "${networkName}" in deploy-params/networks.json (have: ${Object.keys(networks).join(', ')})`,
    );
  }
  return entry;
}

/** True when the active network has a non-empty `dfnsDeployerWalletId` configured. */
export function hasDeployerWalletId(hre: HardhatRuntimeEnvironment): boolean {
  try {
    const id = readNetworkEntry(hre.network.name).dfnsDeployerWalletId;
    return typeof id === 'string' && id.trim() !== '';
  } catch {
    return false;
  }
}

/** The DFNS wallet id for the active network, or throw if it is not configured. */
export function loadDeployerWalletId(hre: HardhatRuntimeEnvironment): string {
  const id = readNetworkEntry(hre.network.name).dfnsDeployerWalletId;
  if (!id || id.trim() === '') {
    throw new Error(
      `No dfnsDeployerWalletId set for network "${hre.network.name}" in deploy-params/networks.json; ` +
        `provision a wallet (tasks/dfns/scripts/provision-deployer-wallet.ts) and commit its id`,
    );
  }
  return id;
}

/**
 * The on-chain address of a DFNS wallet. Read-only (`Wallets:GetWallet`) — used for
 * `forge/hardhat --sender`, preflight balance checks, and the signer identity. Does
 * not request a signature.
 */
export async function resolveDfnsWalletAddress(auth: DfnsAuthConfig, walletId: string): Promise<string> {
  const { address } = await dfnsApiClient(auth).wallets.getWallet({ walletId });
  if (!address) {
    throw new Error(`DFNS wallet ${walletId} has no address`);
  }
  return getAddress(address);
}
