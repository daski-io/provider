-- Skill-level `optionalFields` declaration. Surfaced in the AgentCard so
-- buyer agents can tell which inputs are accepted but not required.
-- This is disjoint from `required_fields` and populated from each
-- service module's manifest at boot.
--
-- See the skill creation best-practices guide for the schema rationale.

ALTER TABLE skills ADD COLUMN IF NOT EXISTS optional_fields JSONB;
