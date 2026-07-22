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

Dispatch `tier=testnet network=sepolia underlying=0x9b5C…dFfF` deploys the
`testnet/sepolia/wrappers.json` entry keyed by that address (checksum-insensitive).
Adding a chain = new dir + Hardhat network + `<tier>-<network>-deploy` environment; no
workflow edits.

## `network.json`

| Field | Meaning |
| --- | --- |
| `chainId` | Expected chain id; preflight fails on mismatch |
| `dao` | Protocol DAO — the only allowed wrapper `owner` |
| `registry` | `ConfidentialTokenWrappersRegistry` address |
| `minDeployerBalanceWei` | Preflight min deployer balance (string wei) |

## `wrappers.json`

| Field | Type | Required | Notes / default |
| --- | --- | --- | --- |
| `name` | string | optional | Default `Confidential <underlying name()>` |
| `symbol` | string | optional | Default `c<underlying symbol()>` |
| `contractUri` | string | optional | Default derived `data:` blob from name/symbol |
| `owner` | address | yes | Must equal the network DAO in `network.json` (preflight hard-fails) |
| `blockedUsers` | address[] | yes | Seeded into the denylist; `[]` if none |
| `underlyingDenyListSelector` | bytes4 | yes | `0x00000000` if none |
| `hasUnderlyingDenyListSelector` | boolean | yes | Whether the selector is enabled |

Minimal entry (all optional fields defaulted):

```json
{
  "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF": {
    "owner": "0x998301B557b9f2B27cb4f2CB16035e6f4b09EACf",
    "blockedUsers": [],
    "underlyingDenyListSelector": "0x00000000",
    "hasUnderlyingDenyListSelector": false
  }
}
```
