ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (
  status IN (
    'verified','disputed','proposed','reserved','approval_broadcast',
    'broadcast','pending_confirmation','reconciliation_required',
    'compliance_hold','issued','failed','rejected'
  )
);

CREATE INDEX payments_refund_compliance_hold_idx
  ON payments(updated_at)
  WHERE amount < 0 AND status = 'compliance_hold';
