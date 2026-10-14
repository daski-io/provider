# Synthetic Audit

This Testnet-only example demonstrates an external-job service: a product
that already runs each paid audit as its own asynchronous job, here an
in-memory fake that takes eight hours of its own clock. Copy it, not the
dummy, when your product starts a job, can find it again by an order key and
reports through a poll.

Core admits the funded order durably and answers `submitted`; its worker then
calls the adapter: `start` submits the audit under core's stable
idempotency key, `recoverStart` finds the original job by that key after any
uncertain start (or allows a same-key replay inside the product's 24-hour
guarantee), and `poll` reads the report until it is ready. The adapter never
journals, schedules or retries by itself, and never builds a URL from buyer
input: a stored report URL is accepted only under the reviewed endpoint.

It is not composed in `src/providerServices.ts`, has no real endpoint or
secret, and cannot be built for Base mainnet.
