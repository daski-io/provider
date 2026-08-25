# Changelog

All notable changes to this project will be documented here.

## Unreleased

### Added

- Generic Daski provider starter based on the production provider architecture.
- Dummy reference service with free and paid paths, asset provisioning, docs,
  and co-located tests.
- Testnet-first onboarding, local integration, service-authoring, and AI-agent
  guidance.
- Genericity and composition gates that prevent known provider-specific
  services, suppliers, brands, and policies from entering the starter.

### Changed

- Made optional LLM configuration truly optional and added concise,
  value-redacted startup configuration errors.
- Made dummy input limits Unicode-aware and its provisioned asset identifiers
  task-bound so repeated titles cannot collide.
- Added a safe, dummy-only offline skill walkthrough and documented every
  operator/CI script by risk.
- Collapsed the unpublished inherited migration history into a clean starter
  baseline for new provider databases.

### Removed

- All source, configuration, migrations, documentation, and tests belonging to
  the original provider's marketplace offerings and suppliers.
