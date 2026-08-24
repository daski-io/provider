-- The standard runtime retains provider-wallet authority only for independent
-- ServiceRegistry catalog maintenance. Historical payment, refund, and
-- reputation writes remain inaccessible even though they share the legacy
-- durable journal table.

ALTER TABLE provider_chain_writes ENABLE ROW LEVEL SECURITY;

CREATE POLICY provider_chain_writes_registry_runtime
  ON provider_chain_writes
  USING (purpose IN ('service_registration', 'service_uri_update'))
  WITH CHECK (purpose IN ('service_registration', 'service_uri_update'));
