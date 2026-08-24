-- Platform security hardening. This pre-production migration deliberately
-- rejects legacy plaintext protected-data rows; operators must purge the
-- pre-production data set before applying it rather than carry plaintext
-- into the versioned envelope format.

ALTER TABLE buyers ADD COLUMN last_known_email_hash TEXT;
CREATE INDEX buyers_email_hash_idx ON buyers(last_known_email_hash)
  WHERE last_known_email_hash IS NOT NULL;

ALTER TABLE buyers ADD CONSTRAINT buyers_email_envelope_check
  CHECK (last_known_email IS NULL OR last_known_email LIKE 'daski:v1:%');
ALTER TABLE transactions ADD CONSTRAINT transactions_contact_email_envelope_check
  CHECK (contact_email IS NULL OR contact_email LIKE 'daski:v1:%');
ALTER TABLE push_subscriptions ADD CONSTRAINT push_token_envelope_check
  CHECK (token IS NULL OR token LIKE 'daski:v1:%');

ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_from_envelope_check
  CHECK (from_address LIKE 'daski:v1:%');
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_to_envelope_check
  CHECK (to_address LIKE 'daski:v1:%');
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_subject_envelope_check
  CHECK (subject IS NULL OR subject LIKE 'daski:v1:%');
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_text_envelope_check
  CHECK (body_text IS NULL OR body_text LIKE 'daski:v1:%');
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_html_envelope_check
  CHECK (body_html IS NULL OR body_html LIKE 'daski:v1:%');
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_headers_envelope_check
  CHECK (
    headers IS NULL OR (
      jsonb_typeof(headers) = 'string'
      AND headers #>> '{}' LIKE 'daski:v1:%'
    )
  );
ALTER TABLE emails_inbound ADD COLUMN rfc_message_id TEXT;
ALTER TABLE emails_inbound ADD COLUMN thread_root_hash TEXT;
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_rfc_envelope_check
  CHECK (rfc_message_id IS NULL OR rfc_message_id LIKE 'daski:v1:%');
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_reply_envelope_check
  CHECK (in_reply_to IS NULL OR in_reply_to LIKE 'daski:v1:%');
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_thread_envelope_check
  CHECK (thread_root IS NULL OR thread_root LIKE 'daski:v1:%');
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_classification_reason_envelope_check
  CHECK (classification_reason IS NULL OR classification_reason LIKE 'daski:v1:%');

ALTER TABLE emails_outbound ADD CONSTRAINT emails_outbound_to_envelope_check
  CHECK (to_address LIKE 'daski:v1:%');
ALTER TABLE emails_outbound ADD CONSTRAINT emails_outbound_subject_envelope_check
  CHECK (subject IS NULL OR subject LIKE 'daski:v1:%');
ALTER TABLE emails_outbound ADD CONSTRAINT emails_outbound_text_envelope_check
  CHECK (body_text IS NULL OR body_text LIKE 'daski:v1:%');
ALTER TABLE emails_outbound ADD CONSTRAINT emails_outbound_html_envelope_check
  CHECK (body_html IS NULL OR body_html LIKE 'daski:v1:%');
ALTER TABLE emails_outbound ADD COLUMN thread_root_hash TEXT;
ALTER TABLE emails_outbound ADD CONSTRAINT emails_outbound_reply_envelope_check
  CHECK (in_reply_to IS NULL OR in_reply_to LIKE 'daski:v1:%');
ALTER TABLE emails_outbound ADD CONSTRAINT emails_outbound_thread_envelope_check
  CHECK (thread_root IS NULL OR thread_root LIKE 'daski:v1:%');

ALTER TABLE operator_chats ADD CONSTRAINT operator_chat_content_envelope_check
  CHECK (content LIKE 'daski:v1:%');
ALTER TABLE operator_chats ADD CONSTRAINT operator_chat_tools_envelope_check
  CHECK (tool_calls IS NULL OR (jsonb_typeof(tool_calls) = 'string' AND tool_calls #>> '{}' LIKE 'daski:v1:%'));
ALTER TABLE operator_chats ADD CONSTRAINT operator_chat_actions_envelope_check
  CHECK (suggested_actions IS NULL OR (jsonb_typeof(suggested_actions) = 'string' AND suggested_actions #>> '{}' LIKE 'daski:v1:%'));

ALTER TABLE emails_inbound
  ADD COLUMN processing_mode TEXT,
  ADD COLUMN processing_service_slug TEXT,
  ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN processing_available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN processing_lease_owner TEXT,
  ADD COLUMN processing_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN processing_error TEXT,
  ADD COLUMN to_address_hash TEXT,
  ADD COLUMN processed_at TIMESTAMPTZ,
  ADD COLUMN legal_hold BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT emails_inbound_processing_status_check
    CHECK (processing_status IN ('queued','running','retry','completed','dead_letter')),
  ADD CONSTRAINT emails_inbound_processing_mode_check
    CHECK (processing_mode IS NULL OR processing_mode IN ('email-agent','interceptor'));
CREATE INDEX emails_inbound_processing_idx
  ON emails_inbound(processing_status, processing_available_at, received_at)
  WHERE processing_status IN ('queued','retry','running');
DROP INDEX IF EXISTS emails_inbound_unclassified_idx;
CREATE INDEX emails_inbound_unclassified_idx
  ON emails_inbound(received_at)
  WHERE classification IS NULL OR classification = 'unknown';

ALTER TABLE emails_outbound ADD COLUMN legal_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE emails_outbound ADD COLUMN idempotency_key TEXT UNIQUE;
ALTER TABLE events ADD COLUMN legal_hold BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE rate_limit_buckets (
  bucket_key    TEXT PRIMARY KEY,
  tokens        DOUBLE PRECISION NOT NULL,
  last_refill   TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX rate_limit_buckets_expiry_idx ON rate_limit_buckets(expires_at);

CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX envelope_nonces_retention_idx ON envelope_nonces(used_at);
CREATE INDEX capability_nonces_retention_idx ON capability_nonces(used_at);
CREATE INDEX emails_inbound_received_idx ON emails_inbound(received_at DESC);
CREATE INDEX emails_inbound_thread_hash_idx ON emails_inbound(thread_root_hash, received_at DESC);
CREATE INDEX emails_inbound_to_hash_idx ON emails_inbound(to_address_hash, received_at DESC);
ALTER TABLE emails_inbound ADD CONSTRAINT emails_inbound_processing_error_envelope_check
  CHECK (processing_error IS NULL OR processing_error LIKE 'daski:v1:%');
CREATE INDEX emails_outbound_thread_hash_idx ON emails_outbound(thread_root_hash, sent_at DESC);
CREATE INDEX emails_outbound_sent_idx ON emails_outbound(sent_at DESC);
CREATE INDEX push_subscriptions_health_idx
  ON push_subscriptions(failure_count, last_attempt_at);
