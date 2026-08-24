-- Shared supplier-operation journal.
--
-- One row represents an external supplier mutation that must occur at most
-- once logically. The row is written as an intent before the supplier call.
-- Ambiguous outcomes (timeout, crash, or an error after the request may have
-- landed) remain ambiguous until the service reconciles supplier truth.
-- op_key is the caller-chosen logical identity of the mutation; its unique
-- constraint makes intent claims conditional across replicas.

CREATE TABLE IF NOT EXISTS supplier_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id),
  transaction_id TEXT REFERENCES transactions(id),
  op_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'intent'
    CHECK (state IN ('intent', 'ambiguous', 'confirmed', 'failed')),
  -- Hash of the exact request the intent covers; a retry whose request
  -- drifted must NOT adopt this intent.
  request_fingerprint TEXT,
  result JSONB,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, op_key)
);

CREATE INDEX IF NOT EXISTS supplier_operations_transaction_idx
  ON supplier_operations (transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS supplier_operations_open_idx
  ON supplier_operations (service_id, state)
  WHERE state IN ('intent', 'ambiguous');
