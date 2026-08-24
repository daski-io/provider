-- 008: platform-wide compliance blocklist.
--
-- A confirmed compliance decision on one service must apply to every service.
-- Rows are soft-removed so additions and removals remain auditable.

CREATE TABLE blocked_identities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address  TEXT,
    buyer_token_id  NUMERIC(78, 0),
    reason          TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at      TIMESTAMPTZ,
    removed_by      TEXT,
    CONSTRAINT blocked_identities_target
        CHECK (wallet_address IS NOT NULL OR buyer_token_id IS NOT NULL)
);
CREATE INDEX blocked_identities_token_idx
    ON blocked_identities(buyer_token_id) WHERE removed_at IS NULL;
CREATE INDEX blocked_identities_wallet_idx
    ON blocked_identities(lower(wallet_address)) WHERE removed_at IS NULL;
