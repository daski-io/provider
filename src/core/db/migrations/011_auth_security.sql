-- Authentication, human-action confirmation, and bounded replay state.

CREATE TABLE siwe_nonces (
    nonce_hash      BYTEA PRIMARY KEY,
    issued_ip_hash  BYTEA NOT NULL,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    CONSTRAINT siwe_nonce_hash_length CHECK (octet_length(nonce_hash) = 32),
    CONSTRAINT siwe_nonce_ip_hash_length CHECK (octet_length(issued_ip_hash) = 32),
    CONSTRAINT siwe_nonce_expiry_order CHECK (expires_at > issued_at)
);
CREATE INDEX siwe_nonces_expiry_idx ON siwe_nonces(expires_at);

-- Fixed-window counters shared by every replica. Keys are SHA-256 hashes of
-- the scope and normalized identity, so raw IP addresses are not retained.
CREATE TABLE auth_rate_limit_buckets (
    key_hash       BYTEA PRIMARY KEY,
    window_start   TIMESTAMPTZ NOT NULL,
    request_count  INTEGER NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    CONSTRAINT auth_rate_key_hash_length CHECK (octet_length(key_hash) = 32),
    CONSTRAINT auth_rate_positive_count CHECK (request_count > 0)
);
CREATE INDEX auth_rate_limit_expiry_idx ON auth_rate_limit_buckets(expires_at);

-- Random, single-use approvals for money, compliance, lifecycle, and
-- configuration actions selected by the Operator Agent.
CREATE TABLE operator_confirmation_intents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash       BYTEA NOT NULL UNIQUE,
    operator_wallet  TEXT NOT NULL,
    session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    thread_id        UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    origin_turn_id   UUID NOT NULL REFERENCES operator_chats(id) ON DELETE CASCADE,
    action_name      TEXT NOT NULL,
    arguments_hash   BYTEA NOT NULL,
    target_type      TEXT NOT NULL,
    target_id        TEXT NOT NULL,
    issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,
    approved_at      TIMESTAMPTZ,
    approved_by      TEXT,
    approved_session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    consumed_at      TIMESTAMPTZ,
    consumed_turn_id UUID REFERENCES operator_chats(id),
    CONSTRAINT operator_intent_token_hash_length CHECK (octet_length(token_hash) = 32),
    CONSTRAINT operator_intent_args_hash_length CHECK (octet_length(arguments_hash) = 32),
    CONSTRAINT operator_intent_action_length CHECK (length(action_name) BETWEEN 1 AND 128),
    CONSTRAINT operator_intent_target_type_length CHECK (length(target_type) BETWEEN 1 AND 64),
    CONSTRAINT operator_intent_target_id_length CHECK (length(target_id) BETWEEN 1 AND 256),
    CONSTRAINT operator_intent_expiry_order CHECK (expires_at > issued_at)
);
CREATE INDEX operator_confirmation_expiry_idx
    ON operator_confirmation_intents(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX operator_confirmation_session_idx
    ON operator_confirmation_intents(session_id, issued_at DESC);

CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX sessions_user_label_idx ON sessions(lower(user_label));
ALTER TABLE sessions
    ADD CONSTRAINT sessions_token_hash_length CHECK (octet_length(token_hash) = 32),
    ADD CONSTRAINT sessions_bounded_lifetime CHECK (
        expires_at > created_at
        AND expires_at <= created_at + interval '24 hours'
    );

ALTER TABLE capability_nonces
    ADD COLUMN expires_at TIMESTAMPTZ;
UPDATE capability_nonces
   SET expires_at = used_at + interval '15 minutes'
 WHERE expires_at IS NULL;
ALTER TABLE capability_nonces
    ALTER COLUMN expires_at SET NOT NULL,
    ADD CONSTRAINT capability_nonce_expiry_order CHECK (expires_at > used_at),
    ADD CONSTRAINT capability_type_length CHECK (length(capability_type) BETWEEN 1 AND 128);
CREATE INDEX capability_nonces_expires_at_idx ON capability_nonces(expires_at);

ALTER TABLE envelope_nonces
    ADD CONSTRAINT envelope_message_id_hash_length CHECK (
        length(message_id) = 64 AND message_id ~ '^[0-9a-f]{64}$'
    );
