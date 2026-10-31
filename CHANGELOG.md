# Changelog

All notable changes to this project will be documented here.

## Unreleased

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
