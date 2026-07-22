import '@nomicfoundation/hardhat-chai-matchers';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-verify';
import '@openzeppelin/hardhat-upgrades';
import '@typechain/hardhat';
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import 'hardhat-deploy';
import 'hardhat-gas-reporter';
import 'hardhat-ignore-warnings';
import '@fhevm/hardhat-plugin';
import { task } from 'hardhat/config';
import { HardhatUserConfig, HttpNetworkAccountsUserConfig } from 'hardhat/types';
import { resolve } from 'path';
import 'solidity-coverage';
import 'hardhat-exposed';
import { isDfnsConfigured } from './tasks/utils/dfns';

import './tasks/accounts';
import './tasks/deploy';
import './tasks/deploy-pipeline';
import './tasks/verify';

// Get the environment configuration from .env file
//
// To make use of automatic environment setup:
// - Duplicate .env.example file and name it .env
// - Fill in the environment variables
dotenv.config();

// Set your preferred authentication method
//
// If you prefer using a mnemonic, set a MNEMONIC environment variable
// to a valid mnemonic
const MNEMONIC = process.env.MNEMONIC;

// If you prefer to be authenticated using a private key, set a PRIVATE_KEY environment variable
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const accounts: HttpNetworkAccountsUserConfig | undefined = MNEMONIC
  ? { mnemonic: MNEMONIC }
  : PRIVATE_KEY
    ? [PRIVATE_KEY]
    : undefined;

if (accounts == null && !isDfnsConfigured()) {
  console.warn(
    'No signer configured. Read-only tasks still work; to broadcast transactions, set MNEMONIC or ' +
      'PRIVATE_KEY, or use DFNS custody signing (DFNS_AUTH_TOKEN / DFNS_CRED_ID / DFNS_PRIVATE_KEY / ' +
      'DFNS_DEPLOYER_WALLET_ID).',
  );
}

// Run the test suite with environment variables from `.env.example`
task('test', 'Runs the test suite with environment variables from .env.example').setAction(async (_, hre, runSuper) => {
  // Load `.env.example`
  const envExamplePath = resolve(__dirname, '.env.example');
  if (existsSync(envExamplePath)) {
    dotenv.config({ path: envExamplePath, override: true });
  }
  await runSuper();
});

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.27',
    settings: {
      optimizer: {
        enabled: true,
        runs: 800,
      },
      evmVersion: 'cancun',
    },
  },
  networks: {
    // Networks are named by chain (tier is a deploy-params grouping, not a Hardhat network). CI
    // injects one DEPLOYMENT_RPC_URL per environment; local dev uses <NETWORK>_RPC_URL. chainId is
    // required for the fhevm plugin's verification.
    ethereum: {
      url: process.env.DEPLOYMENT_RPC_URL || process.env.ETHEREUM_RPC_URL || '',
      accounts,
      chainId: 1,
    },
    sepolia: {
      url: process.env.DEPLOYMENT_RPC_URL || process.env.SEPOLIA_RPC_URL || '',
      accounts,
      chainId: 11155111,
    },
    hardhat: {
      // Need this to avoid deployment issues in test
      saveDeployments: false,
    },
  },
  namedAccounts: {
    deployer: {
      default: 0, // wallet address of index[0], of the mnemonic in .env
    },
    alice: {
      default: 1, // wallet address of index[1], of the mnemonic in .env
    },
  },
  gasReporter: {
    currency: 'USD',
    enabled: process.env.REPORT_GAS === 'true',
    showMethodSig: true,
    includeBytecodeInJSON: true,
  },
  typechain: {
    outDir: 'types',
    target: 'ethers-v6',
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY!,
  },
  exposed: {
    imports: true,
    initializers: true,
  },
};

export default config;
