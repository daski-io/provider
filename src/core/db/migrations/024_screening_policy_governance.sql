-- Bind sanctions-screening behavior and the accepted v1 ownership scope to
-- immutable governance evidence. Existing approvals remain retained as
-- legacy evidence but cannot satisfy a policy-hash-aware mainnet gate.
ALTER TABLE compliance_governance_approvals
  ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN policy_hash TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN policy_snapshot JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN scope_risk_acceptance TEXT
    CHECK (scope_risk_acceptance IS NULL OR scope_risk_acceptance LIKE 'daski:v1:%');

CREATE UNIQUE INDEX compliance_governance_approval_policy_unique
  ON compliance_governance_approvals(
    environment, chain_id, policy_hash, lower(blocked_funds_address), evidence_reference_hash
  );
