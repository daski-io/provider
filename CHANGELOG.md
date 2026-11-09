# Changelog

All notable changes to this project will be documented here.

## Unreleased

### Added

- Gateway key rotation without re-issued artifacts. The provider trusted
  exactly one gateway address, `STANDARD_RAIL_GATEWAY_SIGNER`, both for
  short-lived runtime envelopes (quote and intake requests, forwarded quotes,
  dispatches, status queries, lifecycle grants) and for long-lived artifacts
  (the global policy envelopes and the runtime bundle's listing
  preparations). Long-lived artifact hashes cover their signatures and are
  bound into splitters, so a new gateway key could not be adopted without
  invalidating every listing. Two optional settings separate the cases:
  `STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS` keeps the previous signer accepted
  for runtime envelopes while the gateway switches keys, and
  `STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS` lists the signers of the carried
  artifacts. Both default to `STANDARD_RAIL_GATEWAY_SIGNER`, so nothing
  changes until they are set; `STANDARD_RAIL_GATEWAY_SIGNER` must now be a
  non-zero address. No wire or schema change.

### Security

- zod moves from 3.25 to 4.6.7: every zod 3 release is affected by
  GHSA-mrhx-c7xc-m3w5 (high, memory exhaustion while validating oversized
  constrained collections). Zod 4 is stricter about configuration, so check a
  fork's settings before it boots:
  - It refuses `Infinity` for `RATE_LIMIT_GLOBAL_PER_MIN` and
    `RATE_LIMIT_RAIL_PER_MIN`.
  - It refuses integers above 2^53-1 for the `RATE_LIMIT_*_CAPACITY` settings.
  - Configuration error text changes, which matters to a fork that matches
    it in logs.
  - A fork's own zod schemas and error handling must follow the zod 4
    migration: for example `error.errors` is gone, and `required_error` and
    `errorMap` are ignored.
  No schema, wire or provider protocol change in the starter.
