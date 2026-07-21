# Confidential Wrapper deploy params

These files are the reviewed, source-of-truth inputs for the
`contracts-confidential-wrapper-deploy` GitHub Actions workflow. Because deploys
are dispatched from CI with a funded deployer key, the parameters they run with
**must** be PR-reviewed before a deploy can use them. Never inline wrapper
parameters into a workflow dispatch input — add a file here instead.

## Layout

```
deploy-params/
├── networks.json          # per-network constants (chainId, DAO, registry, ...)
├── <network>/<wrapper>.json   # one file per wrapper, named by its symbol
└── testnet/cTEST.json     # example / CI test vector (Sepolia mock underlying)
```

`<network>` is the Hardhat network name (`testnet` for Sepolia, `mainnet` for
Ethereum). `<wrapper>` is the workflow's `wrapper` dispatch input: dispatching
`network=testnet wrapper=cTEST` deploys `deploy-params/testnet/cTEST.json`.

## `networks.json`

| Field | Meaning |
| --- | --- |
| `chainId` | Expected `eth_chainId` for the network; preflight fails on mismatch |
| `ozManifest` | OpenZeppelin manifest filename under `.openzeppelin/` for this chain |
| `dao` | Protocol DAO for the chain — the **only** allowed wrapper `owner` |
| `registry` | `ConfidentialTokenWrappersRegistry` address (for post-deploy checks + registration calldata) |
| `minDeployerBalanceWei` | Preflight fails if the deployer balance is below this (string wei) |

## `<network>/<wrapper>.json`

Fields mirror `ConfidentialWrapperInitConfig` (the `initialize` inputs):

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Human-readable token name; also derives the deployment artifact names |
| `symbol` | string | Token symbol, e.g. `cUSDT` (matches the file stem) |
| `contractUri` | string | `data:application/json;utf8,{...}` metadata blob |
| `underlying` | address | Underlying ERC-20; must be a deployed contract on the target chain |
| `owner` | address | **MUST equal the network DAO** in `networks.json`. Any other owner breaks governance execution; preflight hard-fails and there is no CI escape hatch — exceptional deploys use the manual runbook. |
| `blockedUsers` | address[] | Seeded into the wrapper denylist at `initialize`; `[]` if none |
| `underlyingDenyListSelector` | bytes4 | Selector used to query the underlying denylist; `0x00000000` if none |
| `hasUnderlyingDenyListSelector` | boolean | Whether the selector above is enabled |

See [`docs/deployment/deploy-wrapper-runbook.md`](../../../docs/deployment/deploy-wrapper-runbook.md)
for the full deployment process.
