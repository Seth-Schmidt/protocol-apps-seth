/**
 * Resolve the DFNS deployer wallet from the environment. The wallet id maps to a public address
 * (non-sensitive) but is provided via `DFNS_DEPLOYER_WALLET_ID` alongside the DFNS auth (see
 * `auth.ts`) so all DFNS config lives in one place instead of split with committed config.
 */
import { dfnsApiClient, type DfnsAuthConfig } from './auth';
import { getAddress } from 'ethers';

const DEPLOYER_WALLET_ID_ENV_VAR = 'DFNS_DEPLOYER_WALLET_ID';

/** True when `DFNS_DEPLOYER_WALLET_ID` is set (non-empty). */
export function hasDeployerWalletId(): boolean {
  const id = process.env[DEPLOYER_WALLET_ID_ENV_VAR];
  return typeof id === 'string' && id.trim() !== '';
}

/** The DFNS wallet id from the environment, or throw if it is not set. */
export function loadDeployerWalletId(): string {
  const id = process.env[DEPLOYER_WALLET_ID_ENV_VAR];
  if (!id || id.trim() === '') {
    throw new Error(
      `${DEPLOYER_WALLET_ID_ENV_VAR} is not set; provision a wallet ` +
        `(tasks/utils/dfns/scripts/provision-deployer-wallet.ts) and set its id in the environment`,
    );
  }
  return id.trim();
}

/** The on-chain address of a DFNS wallet, via the read-only `Wallets:GetWallet`. */
export async function resolveDfnsWalletAddress(auth: DfnsAuthConfig, walletId: string): Promise<string> {
  const { address } = await dfnsApiClient(auth).wallets.getWallet({ walletId });
  if (!address) {
    throw new Error(`DFNS wallet ${walletId} has no address`);
  }
  return getAddress(address);
}
