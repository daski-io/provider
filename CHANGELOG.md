# Changelog

All notable changes to this project will be documented here.

## Unreleased

### Security

- zod moves from 3.25 to 4.6.7: every zod 3 release is affected by
  GHSA-mrhx-c7xc-m3w5 (high, memory exhaustion while validating oversized
  constrained collections). Zod 4 is stricter about configuration, so check a
  fork's settings: it can refuse `BASE_URL` and `SUPPORT_EMAIL` values zod 3
  accepted, and it refuses `Infinity` for `RATE_LIMIT_GLOBAL_PER_MIN` and
  `RATE_LIMIT_RAIL_PER_MIN`. No schema, wire or provider protocol change.
