-- A successful attest() receipt alone no longer finalizes a reputation
-- outcome: the worker now verifies the canonical EAS Attested event and
-- reads the attestation back from EAS state before marking the outcome
-- final, recording the verified attestation UID alongside the finality
-- evidence.
ALTER TABLE standard_reputation_outcomes
  ADD COLUMN attestation_uid BYTEA
    CHECK (attestation_uid IS NULL OR octet_length(attestation_uid) = 32);
