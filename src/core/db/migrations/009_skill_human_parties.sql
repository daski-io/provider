-- 009: skills.human_parties.
--
-- Daski skills are agent-first. Some real-world services nevertheless require
-- a human party of record. This field lets buyer agents discover that
-- requirement before ordering:
--   'required' — every fulfillment requires human-party data.
--   'varies'   — the requirement depends on product or jurisdiction.
--   'none'     — fulfillment requires no human-party data.
-- NULL means the service did not declare the requirement.

ALTER TABLE skills ADD COLUMN IF NOT EXISTS human_parties TEXT
    CHECK (human_parties IS NULL OR human_parties IN ('required', 'varies', 'none'));
