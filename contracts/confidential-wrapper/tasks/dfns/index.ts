/**
 * DFNS deployer entry points for the Hardhat deploy tasks.
 *
 * The signing path activates only when BOTH the DFNS auth secrets are present in the
 * environment AND the active network has a committed `dfnsDeployerWalletId`; deploy
 * tasks fall back to the local `PRIVATE_KEY`/`MNEMONIC` signer otherwise (see
 * `getDeployerSigner` in ../deploy.ts).
 */
import { hasDfnsAuthEnv, loadDfnsAuth, dfnsApiClient } from './auth';
import { DfnsSigner } from './signer';
import { hasDeployerWalletId, loadDeployerWalletId, resolveDfnsWalletAddress } from './wallets';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

export { hasDfnsAuthEnv, loadDfnsAuth, normalizePem, dfnsApiClient, DFNS_AUTH_ENV_VARS } from './auth';
export { DfnsSigner } from './signer';
export { hasDeployerWalletId, loadDeployerWalletId, resolveDfnsWalletAddress } from './wallets';

/** True when DFNS should be used to sign: auth secrets set AND a wallet id committed. */
export function isDfnsConfigured(hre: HardhatRuntimeEnvironment): boolean {
  return hasDfnsAuthEnv() && hasDeployerWalletId(hre);
}

/**
 * Resolve the DFNS deployer address for the active network. Read-only DFNS API call
 * (`Wallets:GetWallet`) — makes no RPC request, so it works in the "resolve deployer
 * address" workflow step without RPC secrets.
 */
export async function resolveDfnsDeployerAddress(hre: HardhatRuntimeEnvironment): Promise<string> {
  const auth = loadDfnsAuth();
  const walletId = loadDeployerWalletId(hre);
  return resolveDfnsWalletAddress(auth, walletId);
}

/** A `DfnsSigner` for the active network, connected to the Hardhat RPC provider. */
export async function loadDfnsDeployerSigner(hre: HardhatRuntimeEnvironment): Promise<DfnsSigner> {
  const auth = loadDfnsAuth();
  const walletId = loadDeployerWalletId(hre);
  const address = await resolveDfnsWalletAddress(auth, walletId);
  const dfns = dfnsApiClient(auth);
  return new DfnsSigner(dfns, walletId, address, hre.ethers.provider);
}
