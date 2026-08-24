-- Operational indexes (audit 4.1).
--
-- emails_outbound.message_id: the Postmark delivery webhook updates rows
-- by provider message id; without an index that is a sequential scan per
-- webhook. events.created_at: the retention worker deletes by bare
-- created_at, which the existing composite indexes cannot serve.

CREATE INDEX IF NOT EXISTS emails_outbound_message_id_idx
    ON emails_outbound (message_id)
    WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_created_at_idx
    ON events (created_at);
