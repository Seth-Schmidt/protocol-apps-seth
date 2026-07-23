import { getConfidentialWrapperProxyName } from './deploy';
import { getRequiredEnvVar } from './utils/loadVariables';
import { task, types } from 'hardhat/config';

function isAlreadyVerified(err: unknown): boolean {
  return /already verified/i.test(err instanceof Error ? err.message : String(err));
}

// Verify a confidential wrapper: implementation is required; proxy source/link is best-effort.
//
// The ERC1967Proxy bytecode comes from @openzeppelin/upgrades-core (solc 0.8.29), not this
// repo's hardhat solc (0.8.27). OZ's hardhat-upgrades interceptor handles that when verifying a
// proxy address — do not pass constructorArguments (OZ infers them).
//
// Example:
//   npx hardhat task:verifyConfidentialWrapper --proxy-address 0x… --network sepolia
task('task:verifyConfidentialWrapper')
  .addParam('proxyAddress', 'The address of the confidential wrapper proxy contract to verify', '', types.string)
  .setAction(async function ({ proxyAddress }, hre) {
    const { upgrades, run } = hre;
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log(`Verifying implementation at ${implementationAddress}…\n`);
    try {
      await run('verify:verify', {
        address: implementationAddress,
        constructorArguments: [],
      });
    } catch (err) {
      if (!isAlreadyVerified(err)) throw err;
      console.log(`Implementation ${implementationAddress} already verified.`);
    }

    // Best-effort: OZ interceptor verifies the bundled ERC1967Proxy + links proxy→impl.
    // Rate limits / solc-fallback noise must not fail the task once the impl is verified.
    console.log(`\nVerifying proxy at ${proxyAddress} (best-effort)…\n`);
    try {
      await run('verify:verify', { address: proxyAddress });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAlreadyVerified(err)) {
        console.log(`Proxy ${proxyAddress} already verified.`);
        return;
      }
      console.warn(`Proxy verify/link failed (implementation is verified):\n${msg}`);
    }
  });

// Verify all confidential wrapper contracts
// Since all confidential wrapper contracts share the same implementation, we normally only have to
// verify one of them. However, since they are proxied, verifying all of them has the benefit of linking
// the proxies with their implementation on Etherscan.
// Example usage:
//   npx hardhat task:verifyAllConfidentialWrappers --network sepolia
task('task:verifyAllConfidentialWrappers').setAction(async function (_, hre) {
  const { run, deployments } = hre;
  const { get } = deployments;

  const numWrappers = parseInt(getRequiredEnvVar('NUM_CONFIDENTIAL_WRAPPERS'));

  for (let i = 0; i < numWrappers; i++) {
    const symbol = getRequiredEnvVar(`CONFIDENTIAL_WRAPPER_SYMBOL_${i}`);

    try {
      const proxyAddress = await get(getConfidentialWrapperProxyName(symbol));
      await run('task:verifyConfidentialWrapper', { proxyAddress: proxyAddress.address });
    } catch (error) {
      console.error('An error occurred:', error);
    }
  }
});
