/**
 * DFNS deployer entry points for the Hardhat deploy tasks. The signing path activates only when
 * the DFNS auth secrets AND `DFNS_DEPLOYER_WALLET_ID` are set; otherwise deploy tasks fall back to
 * the local `PRIVATE_KEY`/`MNEMONIC` signer (see `getDeployerSigner` in ../deploy.ts).
 */
import { hasDfnsAuthEnv, loadDfnsAuth, dfnsApiClient } from './auth';
import { DfnsSigner } from './signer';
import { hasDeployerWalletId, loadDeployerWalletId, resolveDfnsWalletAddress } from './wallets';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

export { hasDfnsAuthEnv, loadDfnsAuth, normalizePem, dfnsApiClient, DFNS_AUTH_ENV_VARS } from './auth';
export { DfnsSigner } from './signer';
export { hasDeployerWalletId, loadDeployerWalletId, resolveDfnsWalletAddress } from './wallets';

/** True when DFNS should be used to sign: auth secrets set AND DFNS_DEPLOYER_WALLET_ID set. */
export function isDfnsConfigured(): boolean {
  return hasDfnsAuthEnv() && hasDeployerWalletId();
}

/** Resolve the DFNS deployer address via the read-only `Wallets:GetWallet`. No RPC request. */
export async function resolveDfnsDeployerAddress(_hre: HardhatRuntimeEnvironment): Promise<string> {
  const auth = loadDfnsAuth();
  const walletId = loadDeployerWalletId();
  return resolveDfnsWalletAddress(auth, walletId);
}

/** A `DfnsSigner` for the active network, connected to the Hardhat RPC provider. */
export async function loadDfnsDeployerSigner(hre: HardhatRuntimeEnvironment): Promise<DfnsSigner> {
  const auth = loadDfnsAuth();
  const walletId = loadDeployerWalletId();
  const address = await resolveDfnsWalletAddress(auth, walletId);
  const dfns = dfnsApiClient(auth);
  return new DfnsSigner(dfns, walletId, address, hre.ethers.provider);
}
