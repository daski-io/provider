-- 007: generic asset lifecycle and protected-artifact groundwork.
--
-- 1. assets.status gains 'suspended', a reversible live-but-degraded state.
-- 2. The one-live-asset-per-identifier guarantee covers all live states so a
--    suspended or grace-period asset still owns its identifier.
-- 3. artifact_secrets stores encrypted, show-once artifact fields for any
--    service. responseBuilder reveals a value only inside its validity window.

ALTER TABLE assets DROP CONSTRAINT assets_status_check;
ALTER TABLE assets ADD CONSTRAINT assets_status_check
    CHECK (status IN ('active','suspended','expired','transferred_out','deleted'));

DROP INDEX assets_active_unique;
CREATE UNIQUE INDEX assets_live_unique
    ON assets(service_id, identifier) WHERE status IN ('active','suspended','expired');

CREATE TABLE artifact_secrets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  TEXT NOT NULL REFERENCES transactions(id),
    artifact_name   TEXT NOT NULL,
    -- Dot-path into the artifact's data payload (e.g. 'credentials.password').
    field_path      TEXT NOT NULL,
    -- AES-256-GCM envelope (core/chain/encryption.ts) of the cleartext value.
    secret          TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    revealed_count  INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (transaction_id, artifact_name, field_path)
);
CREATE INDEX artifact_secrets_tx_idx ON artifact_secrets(transaction_id);
