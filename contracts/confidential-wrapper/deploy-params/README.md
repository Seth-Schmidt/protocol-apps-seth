# Submitting deploy params

## What

`deploy-params/` holds the reviewed, source-of-truth inputs for every ConfidentialWrapper
deployment: one entry per wrapper, under `<tier>/<network>/wrappers.json`. Field-by-field
reference: [`SCHEMA.md`](./SCHEMA.md).

## Why

Wrappers are not deployed from ad-hoc command-line or `.env` inputs. A private CI workflow reads
these files and deploys exactly what they contain, so every constructor and initializer value —
owner, denylist selector, blocked users, observers — goes through normal PR review before anything
is signed onchain. The deployed addresses are then PR'd back here, making this directory the
reviewable record of what was deployed and why.

## How

1. **Add your entry.** Edit `<tier>/<network>/wrappers.json` (e.g. `mainnet/ethereum/wrappers.json`),
   keyed by the wrapper symbol. Only `underlying`, `blockedUsers`, and
   `underlyingDenyListSelector` are required (`0x00000000` disables the check); everything else defaults per
   [`SCHEMA.md`](./SCHEMA.md). Each `underlying` may appear only once per network.
2. **Open a PR** against `main` with just that change. In the description, state the token being
   wrapped and the source for the denylist selector and any blocked users.
3. **Get it reviewed and merged.** Review is the approval gate — merging says these values are
   cleared to deploy.
4. **Zama dispatches the deploy.** The workflow runs against the merged params. You do not need
   access to it.
5. **Results land back here.** A follow-up PR adds the deployment artifacts and addresses. Registry
   registration is a separate Protocol DAO governance action.
