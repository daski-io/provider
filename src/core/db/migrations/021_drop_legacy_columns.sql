-- Phase 5 dead-schema sweep (audit 5.1). Pre-production: no compat path.
--
-- reputation_submissions.fulfillment_time was written as NULL by every
-- caller since the 2026-05-12 EAS refactor — the resolver derives
-- fulfillmentTime from PaymentRouter.PaymentRecord.paidAt on-chain, so a
-- provider-supplied value was never read by anything.
ALTER TABLE reputation_submissions DROP COLUMN IF EXISTS fulfillment_time;

-- services.adapter_config was write-only: registration always stored '{}'
-- and no code path ever read it back. Per-skill knobs live in
-- skills.config; supplier credentials live in supplier_configs.
ALTER TABLE services DROP COLUMN IF EXISTS adapter_config;
