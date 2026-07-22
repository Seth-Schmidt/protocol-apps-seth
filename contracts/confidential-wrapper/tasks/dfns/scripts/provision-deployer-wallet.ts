/**
 * Provision the DFNS deployer wallet for the confidential-wrapper deploy pipeline.
 *
 * Slimmed from confidential-defi's `provision-dfns-wallet.ts`: ONE deployer role, and
 * **print-only** — no `gh secret` push and no 1Password. You paste the printed wallet
 * id into `deploy-params/networks.json` (`dfnsDeployerWalletId`) via a normal PR, so
 * provisioning needs zero repo-admin privilege (the id maps to a public address and
 * is not a secret). Needs only the DFNS auth credentials (DFNS_AUTH_TOKEN /
 * DFNS_CRED_ID / DFNS_PRIVATE_KEY); never the blockchain key.
 *
 * Idempotent: an existing Active wallet named `confidential-wrapper-deployer` on the
 * network is reused, so re-running is a safe no-op that just re-prints the ids.
 *
 *   Run:  npx ts-node tasks/dfns/scripts/provision-deployer-wallet.ts [--network testnet|mainnet]
 *   (omit --network to provision both)
 */
import { dfnsApiClient, loadDfnsAuth } from '../auth';

// DFNS network names are narrower than the SDK's full union so `createWallet` keeps
// the literal type. Each maps to the deploy-params/networks.json network key.
type Target = { networkKey: 'testnet' | 'mainnet'; dfnsNetwork: 'Ethereum' | 'EthereumSepolia' };

const WALLET_NAME = 'confidential-wrapper-deployer';
const TARGETS: Target[] = [
  { networkKey: 'testnet', dfnsNetwork: 'EthereumSepolia' },
  { networkKey: 'mainnet', dfnsNetwork: 'Ethereum' },
];

function parseTargets(argv: string[]): Target[] {
  const idx = argv.indexOf('--network');
  if (idx === -1) return TARGETS;
  const value = argv[idx + 1];
  const target = TARGETS.find(t => t.networkKey === value);
  if (!target) {
    throw new Error(`--network must be one of: ${TARGETS.map(t => t.networkKey).join(', ')}; got ${value}`);
  }
  return [target];
}

type Provisioned = { networkKey: string; dfnsNetwork: string; walletId: string; address: string };

async function main(): Promise<void> {
  const targets = parseTargets(process.argv.slice(2));
  // Auth-only (no wallet id): provisioning runs before any wallet id is known.
  const client = dfnsApiClient(loadDfnsAuth());

  const existing = (await client.wallets.listWallets()).items.filter(
    w => w.name === WALLET_NAME && w.status === 'Active',
  );

  const provisioned: Provisioned[] = await Promise.all(
    targets.map(async ({ networkKey, dfnsNetwork }) => {
      const found = existing.find(w => w.network === dfnsNetwork);
      if (found) {
        if (!found.address) {
          throw new Error(`Wallet ${found.id} on ${dfnsNetwork} has no address yet; retry shortly`);
        }
        console.log(`↺ reusing existing ${dfnsNetwork} wallet ${found.id} (${found.address})`);
        return { networkKey, dfnsNetwork, walletId: found.id, address: found.address };
      }
      const created = await client.wallets.createWallet({ body: { network: dfnsNetwork, name: WALLET_NAME } });
      if (!created.address) {
        throw new Error(`DFNS returned no address for the new ${dfnsNetwork} wallet ${created.id}`);
      }
      console.log(`✅ created ${dfnsNetwork} wallet ${created.id} (${created.address})`);
      return { networkKey, dfnsNetwork, walletId: created.id, address: created.address };
    }),
  );

  console.log('\nDeployer wallets provisioned. Commit these ids into deploy-params/networks.json:');
  for (const p of provisioned) {
    console.log(`  ${p.networkKey}: "dfnsDeployerWalletId": "${p.walletId}"   (address ${p.address})`);
  }
  console.log('\nThen fund each address with gas before deploying, and set the DFNS auth secrets');
  console.log('(DFNS_AUTH_TOKEN / DFNS_CRED_ID / DFNS_PRIVATE_KEY) in the <network>-deploy environment.');
}

main().catch((err: unknown) => {
  console.error(`DFNS deployer-wallet provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
