# Changelog

All notable changes to this project will be documented here.

## Unreleased

### Security

- zod moves from 3.25 to 4.6.7: every zod 3 release is affected by
  GHSA-mrhx-c7xc-m3w5 (high, memory exhaustion while validating oversized
  constrained collections). Zod 4 is stricter about configuration, so check a
  fork's `BASE_URL` and `SUPPORT_EMAIL`: it can refuse URL and email values
  zod 3 accepted. No schema, wire or provider protocol change.
