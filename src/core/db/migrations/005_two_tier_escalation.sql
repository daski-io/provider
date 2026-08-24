-- =============================================================================
-- Two-tier escalation (email-agent-v2 spec §5).
--
-- The Email Agent stops escalating directly to a human; it escalates to the
-- Operator Agent, which triages autonomously and only pulls in a human via a
-- per-escalation chat thread with quick-action buttons. This migration is
-- additive: existing pre-execute escalations (status 'pending'/'approved'/
-- 'edited'/'rejected') keep working.
-- =============================================================================

-- ── escalations: nullable transaction_id + new lifecycle + agent fields ──────

-- An escalation can now exist without a transaction (unknown sender,
-- pre-sales question routed via the Email Agent).
ALTER TABLE escalations ALTER COLUMN transaction_id DROP NOT NULL;

-- Extend the status vocabulary. Keep the legacy pre-execute statuses
-- ('approved','edited') so engine/escalation.ts's resolve flow is unchanged.
ALTER TABLE escalations DROP CONSTRAINT escalations_status_check;
ALTER TABLE escalations ADD CONSTRAINT escalations_status_check CHECK (
  status IN (
    'pending',           -- pre-execute: awaiting human (unchanged)
    'in_agent_review',   -- assigned to the Operator Agent (autonomous triage)
    'awaiting_human',    -- Operator Agent surfaced it; awaiting a human reply
    'resolved',          -- closed by agent or human
    'rejected',          -- closed: declined
    'approved',          -- legacy pre-execute resolution
    'edited'             -- legacy pre-execute resolution
  )
);

-- The Email Agent now sets source='email_agent', assignee='operator_agent'.
ALTER TABLE escalations ADD COLUMN assignee TEXT;             -- 'operator_agent' | 'human'
ALTER TABLE escalations ADD COLUMN agent_recommendation TEXT; -- the agent's proposed action

-- Captures the inbound email context so the Operator Agent can reply in
-- thread even when the escalation isn't bound to a transaction.
ALTER TABLE escalations ADD COLUMN inbound_id UUID REFERENCES emails_inbound(id);

-- ── chat_threads: per-escalation threads + the free-form operator chat ───────
--
-- The free-form Operator chat is the thread with escalation_id IS NULL (one
-- per wallet). Escalation threads bind to one escalation each.
CREATE TABLE chat_threads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT,
  escalation_id  UUID REFERENCES escalations(id),
  title          TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_threads_status_check CHECK (status IN ('open','resolved','rejected'))
);
CREATE INDEX chat_threads_wallet_idx ON chat_threads(wallet_address, updated_at DESC);
-- At most one thread per escalation.
CREATE UNIQUE INDEX chat_threads_escalation_idx
  ON chat_threads(escalation_id) WHERE escalation_id IS NOT NULL;
-- At most one free-form thread per wallet.
CREATE UNIQUE INDEX chat_threads_freeform_idx
  ON chat_threads(wallet_address) WHERE escalation_id IS NULL;

-- Now that chat_threads exists, link escalations to their thread.
ALTER TABLE escalations ADD COLUMN thread_id UUID REFERENCES chat_threads(id);

-- ── operator_chats: thread scoping + quick-action buttons ────────────────────
ALTER TABLE operator_chats ADD COLUMN thread_id UUID REFERENCES chat_threads(id);
-- Quick-action buttons attached to an agent message, e.g.
-- [{"label":"Approve refund","value":"approve"}, ...]. Null on non-agent rows.
ALTER TABLE operator_chats ADD COLUMN suggested_actions JSONB;
CREATE INDEX operator_chats_thread_idx ON operator_chats(thread_id, created_at);
