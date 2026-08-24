-- =============================================================================
-- daski-provider — fresh v4 schema
--
-- This migration is the v4 BASELINE: the pre-redesign migration chain was
-- collapsed into this file and the database reset rather than migrated
-- row-by-row (see docs/backend-v2-spec.md for the design rationale).
-- Post-baseline changes live in the numbered migrations that follow
-- (002_..., 003_..., …) and are checksummed by the runner.
-- =============================================================================

-- gen_random_uuid() is built into PostgreSQL 13+; pgcrypto is a safe no-op on
-- newer versions and a fallback on older deployments.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. Identity & catalog (no FKs to anything below)
-- =============================================================================

-- A buyer is identified by their ERC-8004 token id. Materialised lazily on
-- first transaction. settleWithRegistration can mint a buyer in the same tx
-- as settlement; the provider must accept buyers it didn't know at challenge
-- time, so this table is write-on-demand.
CREATE TABLE buyers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_id          BIGINT NOT NULL UNIQUE,
    wallet_address    TEXT,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_known_email  TEXT
);
CREATE INDEX buyers_wallet_idx ON buyers(wallet_address) WHERE wallet_address IS NOT NULL;

-- A provider-side service grouping. Each row
-- maps 1:1 to an on-chain ServiceRegistry entry once registered.
-- on_chain_id = keccak256(providerAgentId, slug, version), populated by the
-- ServiceRegistrar bootstrap on first boot.
CREATE TABLE services (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT NOT NULL,
    slug                  TEXT NOT NULL,
    version               TEXT NOT NULL DEFAULT '1',
    category_family       TEXT NOT NULL,
    service_type          TEXT NOT NULL,
    jurisdictions         JSONB NOT NULL,
    turnaround_estimate   TEXT,
    service_lifecycle     TEXT NOT NULL DEFAULT 'one-shot',
    service_description   TEXT NOT NULL,
    adapter_name          TEXT NOT NULL,
    adapter_config        JSONB NOT NULL DEFAULT '{}',
    agent_domain          TEXT,
    supplier              TEXT,
    outbound_email_from   TEXT,
    inbound_email_address TEXT,
    on_chain_id           BYTEA,
    service_wallet        TEXT,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT services_jurisdictions_check CHECK (
      jsonb_typeof(jurisdictions) = 'array' AND jsonb_array_length(jurisdictions) > 0
    ),
    UNIQUE (slug, version)
);
CREATE UNIQUE INDEX services_inbound_email_idx
    ON services(inbound_email_address) WHERE inbound_email_address IS NOT NULL;
CREATE UNIQUE INDEX services_on_chain_idx
    ON services(on_chain_id) WHERE on_chain_id IS NOT NULL;

-- Off-chain operations under a service. Pricing scheme lives in `pricing` JSONB
-- (see src/core/pricing/ for the schema and helpers). Runtime knobs live in
-- `config` JSONB (e.g. config.llm = { model, timeout_ms, enabled } for the
-- pre-execute hook).
CREATE TABLE skills (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id               UUID NOT NULL REFERENCES services(id),
    skill_id                 TEXT NOT NULL,
    name                     TEXT NOT NULL,
    description              TEXT NOT NULL,
    tags                     JSONB,
    pricing                  JSONB NOT NULL,
    required_fields          JSONB,
    optional_fields          JSONB,
    requires_asset_ownership BOOLEAN NOT NULL DEFAULT false,
    asset_type               TEXT,
    sort_order               INTEGER NOT NULL DEFAULT 0,
    is_active                BOOLEAN NOT NULL DEFAULT true,
    requires_capability      BOOLEAN NOT NULL DEFAULT false,
    capability_type          TEXT,
    fulfillment_mode         TEXT NOT NULL,
    config                   JSONB NOT NULL DEFAULT '{}',
    examples                 JSONB,
    documentation_url        TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT skills_fulfillment_mode_check CHECK (
      fulfillment_mode IN ('automated', 'human', 'hybrid')
    ),
    UNIQUE (service_id, skill_id)
);
CREATE INDEX skills_active_idx ON skills(service_id, is_active);

-- Asset state reflects fulfillment state only. Refunds do not change asset.status.
CREATE TABLE assets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  UUID NOT NULL REFERENCES services(id),
    type        TEXT NOT NULL,
    identifier  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    metadata    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    CONSTRAINT assets_status_check CHECK (status IN ('active','expired','transferred_out','deleted'))
);
CREATE UNIQUE INDEX assets_active_unique
    ON assets(service_id, identifier) WHERE status = 'active';
CREATE INDEX assets_identifier_idx ON assets(identifier);
CREATE INDEX assets_status_idx ON assets(status);

-- Per-supplier credentials and tunable knobs. Operator
-- term: a "supplier" is the external backing service for a Daski "service",
-- distinct from the on-chain "Provider" entity (PROVIDER_AGENT_ID env).
CREATE TABLE supplier_configs (
    supplier              TEXT PRIMARY KEY,
    credentials_encrypted TEXT NOT NULL,
    sandbox               BOOLEAN NOT NULL DEFAULT false,
    notes                 TEXT,
    config                JSONB NOT NULL DEFAULT '{}',
    updated_by            TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operator-curated text rules injected into LLM prompts. Per-service,
-- optionally per-skill, with a scope discriminator. Only the Operator Agent
-- writes to this table — Email Agent has no rule-writing authority.
CREATE TABLE service_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  UUID NOT NULL REFERENCES services(id),
    skill_id    TEXT,
    scope       TEXT NOT NULL DEFAULT 'all',
    rule        TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    active      BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT service_rules_scope_check CHECK (scope IN ('all','email_agent','pre_execute'))
);
CREATE INDEX service_rules_active_idx ON service_rules(service_id, active);
CREATE INDEX service_rules_skill_idx ON service_rules(skill_id, active);

-- Admin UI cookie sessions. SIWE login produces a row; cookie carries the id;
-- user_label is the authenticated wallet address.
CREATE TABLE sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash    BYTEA NOT NULL UNIQUE,
    user_label    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replay protection for EIP-712 capabilities. A primary-key
-- violation on retry = replay attack; insert only happens after the
-- capability otherwise passes verification.
CREATE TABLE capability_nonces (
    buyer_token_id   NUMERIC(78, 0) NOT NULL,
    nonce            BYTEA NOT NULL,
    capability_type  TEXT NOT NULL,
    used_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (buyer_token_id, nonce)
);
CREATE INDEX capability_nonces_used_at_idx ON capability_nonces(used_at);

-- A2A envelope-auth replay ledger. The buyer's agent wallet signs an
-- EIP-712 A2ARequestAuthorization committing to the messageId; the
-- provider atomically claims (buyer_token_id, message_id) here on each
-- successful verification. A repeat insert collides and the verifier
-- refuses to execute. messageId is already a unique-per-request UUID by
-- A2A convention; capturing it server-side closes the replay window.
CREATE TABLE envelope_nonces (
    buyer_token_id   NUMERIC(78, 0) NOT NULL,
    message_id       TEXT NOT NULL, -- SHA-256 digest; raw caller ids are never retained
    used_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (buyer_token_id, message_id)
);
CREATE INDEX envelope_nonces_used_at_idx ON envelope_nonces(used_at);

-- =============================================================================
-- 2. Transactions and dependents
-- =============================================================================

-- One row per skill execution. PK type is TEXT to remain compatible with A2A
-- wire format (task ids are arbitrary strings, usually UUIDs).
CREATE TABLE transactions (
    id             TEXT PRIMARY KEY,
    buyer_id       UUID NOT NULL REFERENCES buyers(id),
    asset_id       UUID REFERENCES assets(id),
    service_id     UUID NOT NULL REFERENCES services(id),
    skill_id       TEXT NOT NULL,
    service_ref    BYTEA UNIQUE,
    status         TEXT NOT NULL,
    contact_email  TEXT,
    metadata       JSONB NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ,
    CONSTRAINT transactions_status_check CHECK (
      status IN ('submitted','working','input-required','completed','failed','canceled')
    )
);
CREATE INDEX transactions_buyer_idx   ON transactions(buyer_id);
CREATE INDEX transactions_asset_idx   ON transactions(asset_id);
CREATE INDEX transactions_service_idx ON transactions(service_id);
CREATE INDEX transactions_status_idx  ON transactions(status);
CREATE INDEX transactions_created_idx ON transactions(created_at DESC);

-- One row per money movement. Initial settlement = positive amount,
-- refund = negative amount (signed). Status carries the lifecycle.
-- onchain_payment_id (BIGINT) = PaymentRouter.PaymentRecord id; renamed from
-- payment_id to disambiguate from payments.id (UUID).
CREATE TABLE payments (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id       TEXT NOT NULL REFERENCES transactions(id),
    service_ref          BYTEA NOT NULL,
    onchain_payment_id   BIGINT NOT NULL,
    transaction_hash     TEXT,
    amount               BIGINT NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'USDC',
    token_address        TEXT,
    status               TEXT NOT NULL,
    buyer_agent_id       BIGINT,
    provider_agent_id    BIGINT,
    onchain_service_id   BYTEA,
    provider_amount      BIGINT,
    commission           BIGINT,
    paid_at              TIMESTAMPTZ,
    metadata             JSONB NOT NULL DEFAULT '{}',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payments_status_check CHECK (
      status IN ('verified','disputed','proposed','pending','issued','failed','rejected')
    )
);
CREATE INDEX payments_tx_idx          ON payments(transaction_id);
CREATE INDEX payments_status_idx      ON payments(status);
CREATE INDEX payments_service_ref_idx ON payments(service_ref);
CREATE INDEX payments_onchain_id_idx  ON payments(onchain_payment_id);

-- Operator review queue. A transaction can have multiple escalations over
-- its lifetime (e.g. re-escalated after rejection, multiple email questions).
CREATE TABLE escalations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  TEXT NOT NULL REFERENCES transactions(id),
    question        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    response        TEXT,
    edited_data     JSONB,
    source          TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT,
    CONSTRAINT escalations_status_check CHECK (status IN ('pending','approved','edited','rejected')),
    CONSTRAINT escalations_source_check CHECK (source IN ('pre_execute','email_agent','operator','auto'))
);
CREATE INDEX escalations_tx_idx      ON escalations(transaction_id);
CREATE INDEX escalations_pending_idx ON escalations(status) WHERE status = 'pending';
CREATE INDEX escalations_created_idx ON escalations(created_at DESC);

-- Append-only activity log. Drives per-transaction timelines and the
-- Platform Log. Folds in what used to live in adapter_logs, task_messages,
-- and task_artifacts. The A2A endpoint reconstructs message history and
-- artifacts from this table on tasks/get.
CREATE TABLE events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  TEXT REFERENCES transactions(id),
    asset_id        UUID REFERENCES assets(id),
    service_id      UUID REFERENCES services(id),
    source          TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'info',
    type            TEXT NOT NULL,
    message         TEXT NOT NULL,
    payload         JSONB,
    actor           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT events_source_check CHECK (
      source IN ('adapter','email','llm','chain','admin','push','system')
    ),
    CONSTRAINT events_severity_check CHECK (severity IN ('debug','info','warn','error'))
);
CREATE INDEX events_tx_idx       ON events(transaction_id, created_at DESC);
CREATE INDEX events_service_idx  ON events(service_id, created_at DESC);
CREATE INDEX events_source_idx   ON events(source, created_at DESC);
CREATE INDEX events_severity_idx ON events(severity, created_at DESC);
CREATE INDEX events_type_idx     ON events(type, created_at DESC);

-- Buyer-registered webhook URLs for A2A push notifications. Mutable per-row
-- state (delivery_count, failure_count, last_attempt_at) drives circuit-
-- breaker logic; delivery events are also written to `events`.
CREATE TABLE push_subscriptions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id    TEXT NOT NULL REFERENCES transactions(id),
    url               TEXT NOT NULL,
    token             TEXT,
    auth_schemes      JSONB,
    last_attempt_at   TIMESTAMPTZ,
    last_status       INTEGER,
    last_error        TEXT,
    delivery_count    INTEGER NOT NULL DEFAULT 0,
    failure_count     INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (transaction_id, url)
);

-- Inbound email storage. message_id is the Postmark MessageID, used as the
-- dedupe key. classification is set by the Email Agent after running.
CREATE TABLE emails_inbound (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id             TEXT NOT NULL UNIQUE,
    from_address           TEXT NOT NULL,
    to_address             TEXT NOT NULL,
    subject                TEXT,
    body_text              TEXT,
    body_html              TEXT,
    headers                JSONB,
    in_reply_to            TEXT,
    thread_root            TEXT,
    buyer_id               UUID REFERENCES buyers(id),
    service_id             UUID REFERENCES services(id),
    transaction_id         TEXT REFERENCES transactions(id),
    classification         TEXT,
    classification_reason  TEXT,
    received_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX emails_inbound_thread_idx ON emails_inbound(thread_root, received_at DESC);
CREATE INDEX emails_inbound_tx_idx     ON emails_inbound(transaction_id, received_at DESC);
CREATE INDEX emails_inbound_unclassified_idx ON emails_inbound(received_at) WHERE classification IS NULL;

CREATE TABLE emails_outbound (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id        TEXT,
    from_address      TEXT NOT NULL,
    to_address        TEXT NOT NULL,
    subject           TEXT,
    body_text         TEXT,
    body_html         TEXT,
    in_reply_to       TEXT,
    thread_root       TEXT,
    buyer_id          UUID REFERENCES buyers(id),
    service_id        UUID REFERENCES services(id),
    transaction_id    TEXT REFERENCES transactions(id),
    inbound_id        UUID REFERENCES emails_inbound(id),
    sent_by           TEXT NOT NULL,
    sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivery_status   TEXT,
    delivery_payload  JSONB,
    CONSTRAINT emails_outbound_sent_by_check CHECK (
      sent_by IN ('email_agent','operator_agent','admin','system')
    )
);
CREATE INDEX emails_outbound_thread_idx ON emails_outbound(thread_root, sent_at DESC);
CREATE INDEX emails_outbound_tx_idx     ON emails_outbound(transaction_id, sent_at DESC);

-- Per-wallet operator chat history. Replayed back to the LLM on each turn
-- (with a sliding window). System prompt is static and lives in code.
CREATE TABLE operator_chats (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address  TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    tool_calls      JSONB,
    tool_call_id    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT operator_chats_role_check CHECK (role IN ('operator','agent','tool'))
);
CREATE INDEX operator_chats_wallet_idx ON operator_chats(wallet_address, created_at);

-- Provider-side outcome attestations (EAS). Buyer confirmations flow via
-- the gateway, not the provider. fulfillment_time is supplied but on-chain
-- overwrites it from PaymentRecord.paidAt.
CREATE TABLE reputation_submissions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id    TEXT NOT NULL REFERENCES transactions(id),
    payment_id        UUID NOT NULL REFERENCES payments(id),
    outcome           INTEGER NOT NULL,
    fulfillment_time  INTEGER,
    status            TEXT NOT NULL DEFAULT 'pending',
    attestation_uid   BYTEA,
    transaction_hash  TEXT,
    attempts          INTEGER NOT NULL DEFAULT 0,
    last_attempt_at   TIMESTAMPTZ,
    confirmed_at      TIMESTAMPTZ,
    error             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reputation_submissions_status_check CHECK (
      status IN ('pending','submitted','confirmed','failed')
    )
);
CREATE INDEX reputation_submissions_pending_idx
    ON reputation_submissions(status) WHERE status IN ('pending','submitted');
