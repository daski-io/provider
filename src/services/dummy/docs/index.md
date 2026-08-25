# Dummy Notes

Reference service for provider authors — **not a real marketplace
offering**. It exists so the `ServiceModule` contract has a compiled,
tested, always-current demonstration:

| Skill | Price | Gates | Demonstrates |
| --- | --- | --- | --- |
| `echo` | free | none | minimal request→artifact round trip |
| `create-note` | $0.10 | payment | quote validation, paid execution, asset provisioning |

A "note" is an asset: `create-note` provisions it under the payer wallet using
a title-derived kebab-case prefix plus the task id. Repeating a title therefore
cannot collide with an earlier paid order. Length limits and reported counts
use Unicode code points rather than UTF-16 code units. Only the title and body
character count enter asset metadata; the body is not retained. Do not send
sensitive content to this demonstration service.

The dummy intentionally has no asset action because it is not part of the
reviewed launch action catalog.

The service is installed by default for local development and Base Sepolia.
Boot refuses to run it on Base mainnet. Service authors: start at
`docs/adding-a-service.md` in the repository, which walks through turning a
copy of this folder into a real service.
