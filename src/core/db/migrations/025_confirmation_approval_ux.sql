-- Confirmation-intent approval UX rework. The browser approval now posts the
-- intent id (still bound to the operator wallet + SIWE session + thread by the
-- UPDATE's WHERE clause), so the bearer token is retired: it no longer needs
-- to be persisted in chat rows, rendered into HTML, or replayed by the model.
-- The previewed free-text content (refund reason, clearing disposition, rule
-- text, config params) is stored on the intent and executes verbatim on
-- consumption — the model no longer has to reproduce it byte-exactly.
ALTER TABLE operator_confirmation_intents
    ALTER COLUMN token_hash DROP NOT NULL,
    ADD COLUMN pending_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN voided_at TIMESTAMPTZ;

-- The gate looks up the newest live intent for an exact binding on every
-- consequential tool call (re-preview dedupe / supersede / re-issue).
CREATE INDEX operator_confirmation_binding_idx
    ON operator_confirmation_intents(thread_id, action_name, target_type, target_id)
    WHERE consumed_at IS NULL AND voided_at IS NULL;
