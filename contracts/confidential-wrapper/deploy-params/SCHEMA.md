# Deploy params schema

Reviewed, source-of-truth inputs for the `contracts-confidential-wrapper-deploy`
workflow. Full process: [deploy-wrapper-runbook.md](../../../docs/deployment/deploy-wrapper-runbook.md).

## Layout

`<tier>/<network>/`, where **tier** = `testnet` | `mainnet` and **network** = the
Hardhat network name / chain (`sepolia`, `ethereum`, …). The directory is the source
of truth for the tier↔network mapping.

```
deploy-params/
├── testnet/sepolia/{network,wrappers}.json    # network.json: chainId, DAO, registry, …
└── mainnet/ethereum/{network,wrappers}.json
```

Dispatch `target=testnet-sepolia underlying=0x9b5C…dFfF` deploys the
`testnet/sepolia/wrappers.json` entry whose `underlying` matches that address
(checksum-insensitive). Adding a chain = new dir + Hardhat network + `<tier>-<network>-deploy`
environment + the `<tier>-<network>` value added to the workflow's `target` dropdown.

## `network.json`

| Field | Meaning |
| --- | --- |
| `chainId` | Expected chain id; preflight fails on mismatch |
| `dao` | Protocol DAO — the default wrapper `owner` (overridable per entry) |
| `registry` | `ConfidentialTokenWrappersRegistry` address |
| `minDeployerBalanceWei` | Preflight min deployer balance (string wei) |

## `wrappers.json`

`{ wrapperSymbol: entry }` — keyed by the wrapper symbol (e.g. `cUSDT`) so the file is
self-documenting; the wrapped token is the `underlying` field (no separate `symbol` field).

| Field | Type | Required | Notes / default |
| --- | --- | --- | --- |
| `underlying` | address | yes | The ERC-20 being wrapped (looked up by the deploy dispatch); each underlying appears once |
| `blockedUsers` | address[] | yes | Seeded into the denylist; `[]` if none |
| `underlyingDenyListSelector` | bytes4 | yes | `0x00000000` if none |
| `hasUnderlyingDenyListSelector` | boolean | yes | Whether the selector is enabled |
| `owner` | address | optional | Defaults to the network `dao`; set only to intentionally use a non-DAO owner (preflight flags overrides) |
| `name` | string | optional | Default `Confidential <underlying name()>` |
| `contractUri` | string | optional | Default derived `data:` blob from name/symbol |

Minimal entry (owner/name/contractUri defaulted):

```json
{
  "cUSDT": {
    "underlying": "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF",
    "blockedUsers": [],
    "underlyingDenyListSelector": "0x00000000",
    "hasUnderlyingDenyListSelector": false
  }
}
```
