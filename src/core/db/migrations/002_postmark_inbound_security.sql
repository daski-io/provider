-- Persist fail-closed Postmark-derived verdicts at the authenticated webhook
-- boundary. Service handlers must not reinterpret attacker-controlled raw
-- message headers when deciding whether correspondence may affect state.
ALTER TABLE emails_inbound
  ADD COLUMN postmark_sender_authenticated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN postmark_spam_safe BOOLEAN NOT NULL DEFAULT false;
