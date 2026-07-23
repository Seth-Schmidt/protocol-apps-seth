/**
 * Provision the DFNS deployer wallet for the confidential-wrapper deploy pipeline.
 *
 * Print-only: set the printed wallet id as `DFNS_DEPLOYER_WALLET_ID` in the
 * `<tier>-<network>-deploy` environment (and local `.env`) — the id maps to a public address and
 * is not sensitive. Needs only the DFNS auth credentials, never the blockchain key.
 *
 * Idempotent: an existing Active `confidential-wrapper-deployer` wallet is reused, so re-running
 * just re-prints the ids.
 *
 *   Run:  npx ts-node tasks/utils/dfns/scripts/provision-deployer-wallet.ts [--network sepolia|ethereum]
 *   (omit --network to provision both)
 */
import { dfnsApiClient, loadDfnsAuth } from '../auth';

// DFNS network names are narrower than the SDK's union so `createWallet` keeps the literal type.
// networkKey is the Hardhat network whose <tier>-<network>-deploy env gets the printed wallet id.
type Target = { networkKey: 'sepolia' | 'ethereum'; dfnsNetwork: 'Ethereum' | 'EthereumSepolia' };

const WALLET_NAME = 'confidential-wrapper-deployer';
const TARGETS: Target[] = [
  { networkKey: 'sepolia', dfnsNetwork: 'EthereumSepolia' },
  { networkKey: 'ethereum', dfnsNetwork: 'Ethereum' },
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

  console.log('\nDeployer wallets provisioned. Set each id as DFNS_DEPLOYER_WALLET_ID in the');
  console.log('matching <tier>-<network>-deploy environment (and your local .env):');
  for (const p of provisioned) {
    console.log(`  ${p.networkKey}: DFNS_DEPLOYER_WALLET_ID="${p.walletId}"   (address ${p.address})`);
  }
  console.log('\nThen fund each address with gas before deploying, and set the DFNS auth secrets');
  console.log('(DFNS_AUTH_TOKEN / DFNS_CRED_ID / DFNS_PRIVATE_KEY) in the <tier>-<network>-deploy environment.');
}

main().catch((err: unknown) => {
  console.error(`DFNS deployer-wallet provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
