import { getConfidentialWrapperProxyName } from './deploy';
import { getRequiredEnvVar } from './utils/loadVariables';
import { task, types } from 'hardhat/config';

function isAlreadyVerified(err: unknown): boolean {
  return /already verified/i.test(err instanceof Error ? err.message : String(err));
}

// Verify a confidential wrapper contract
// Example usage:
// npx hardhat task:verifyConfidentialWrapper --proxy-address 0x1234567890123456789012345678901234567890 --network sepolia
task('task:verifyConfidentialWrapper')
  .addParam('proxyAddress', 'The address of the confidential wrapper proxy contract to verify', '', types.string)
  .setAction(async function ({ proxyAddress }, hre) {
    const { upgrades, run } = hre;

    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log(`Verifying confidential wrapper proxy contract at ${proxyAddress}...\n`);
    try {
      await run('verify:verify', {
        address: proxyAddress,
        constructorArguments: [],
      });
    } catch (err) {
      if (!isAlreadyVerified(err)) throw err;
      console.log(`Proxy ${proxyAddress} already verified.`);
    }

    console.log(`Verifying confidential wrapper implementation contract at ${implementationAddress}...\n`);
    try {
      await run('verify:verify', {
        address: implementationAddress,
        constructorArguments: [],
      });
    } catch (err) {
      if (!isAlreadyVerified(err)) throw err;
      console.log(`Implementation ${implementationAddress} already verified.`);
    }
  });

// Verify all confidential wrapper contracts
// Since all confidential wrapper contracts share the same implementation, we normally only have to
// verify one of them. However, since they are proxied, verifying all of them has the benefit of linking
// the proxies with their implementation on Etherscan.
// Example usage:
// npx hardhat task:verifyAllConfidentialWrappers --network sepolia
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
