/**
 * An in-memory stand-in for the provider's PostgreSQL rows, precise enough for
 * wire parity: every read stamps `observed_at` from a settable database clock,
 * a new claim takes the fixture's task id, and completion stamps the clock.
 * Transactions, locks and the deferred admission fence are exercised by the
 * PostgreSQL suites; here only the bytes of each answer matter.
 */
export interface WireDatabase {
  clock: number;
  taskId: string;
  failLookups: boolean;
  /** The async-admission switch external-job admission reads. */
  asyncAdmission: boolean;
  claims: Map<string, Record<string, unknown>>;
  /** External-job rows by task id. */
  jobs: Map<string, Record<string, unknown>>;
  quotes: Map<string, Record<string, unknown>>;
  statements: string[];
}

export function createWireDatabase(): WireDatabase {
  return {
    clock: 0, taskId: "", failLookups: false, asyncAdmission: false,
    claims: new Map(), jobs: new Map(), quotes: new Map(), statements: [],
  };
}

export function resetWireDatabase(db: WireDatabase): void {
  db.clock = 0;
  db.failLookups = false;
  db.asyncAdmission = false;
  db.claims.clear();
  db.jobs.clear();
  db.quotes.clear();
  db.statements.length = 0;
}

const hex = (value: unknown) => (value as Buffer).toString("hex");

function observed(db: WireDatabase, row: Record<string, unknown> | undefined) {
  if (!row) return [];
  const job = db.jobs.get(String(row.id));
  return [{ ...row, observed_at: String(db.clock), job_phase: job?.phase ?? row.job_phase ?? null }];
}

/** `pool.query` over the rows the provider's handlers read and write. */
export function wireQuery(db: WireDatabase) {
  return async (sql: string, params: unknown[] = []) => {
    db.statements.push(sql);
    if (sql.includes("rate_limit_buckets")) return { rows: [{ tokens: 1 }], rowCount: 1 };
    if (sql.includes("FROM provider_transactions WHERE gateway_audience=$1 AND order_id=$2")) {
      if (db.failLookups) throw new Error("connection reset by peer");
      return { rows: observed(db, db.claims.get(String(params[1]))) };
    }
    if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
    if (sql.includes("result_diagnostic IS NOT NULL")) return { rows: [{ broken: false }] };
    if (sql.includes("FROM provider_async_admission")) {
      return { rows: [{ enabled: db.asyncAdmission, changed_at: db.asyncAdmission ? new Date(0) : null }] };
    }
    if (sql.includes("INSERT INTO provider_quotes")) {
      const [hash, outcomeId, listing, request, gross, payer, issuedAt, validBefore, retainSeconds] = params;
      db.quotes.set(hex(hash), {
        outcome_id: outcomeId, listing_manifest_hash: listing, request_hash: request,
        gross_amount: gross, payer, issued_at: String(issuedAt), valid_before: String(validBefore),
        retain_seconds: retainSeconds,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM provider_quotes WHERE quote_hash=$1")) {
      const row = db.quotes.get(hex(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("UPDATE provider_transactions") && sql.includes("result_hash=$5")) {
      const row = [...db.claims.values()].find((claim) => claim.id === params[0]);
      if (!row || row.state !== "executing" || row.execution_lease_token !== params[1]) return { rows: [] };
      Object.assign(row, {
        state: params[2], result: JSON.parse(String(params[3])), result_hash: params[4],
        completed_at: new Date(db.clock * 1_000),
      });
      return { rows: observed(db, row) };
    }
    if (sql.includes("SET execution_lease_expires_at=now()")) {
      // Lease renewal: the emulated lease never expires.
      const row = [...db.claims.values()].find((claim) => claim.id === params[0]);
      const held = row?.state === "executing" && row.execution_lease_token === params[1];
      return { rows: [], rowCount: held ? 1 : 0 };
    }
    if (sql.includes("FROM provider_transactions WHERE id=$1")) {
      return { rows: observed(db, [...db.claims.values()].find((claim) => claim.id === params[0])) };
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
  };
}

/** `pool.connect` for the evidence admission and the claim transaction. */
export function wireConnect(db: WireDatabase) {
  return async () => ({
    release: () => undefined,
    query: async (sql: string, params: unknown[] = []) => {
      db.statements.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("INSERT INTO standard_evidence_admissions")) {
        return { rows: [{ evidence_hash: params[0] }], rowCount: 1 };
      }
      if (sql.includes("FOR UPDATE")) return { rows: observed(db, db.claims.get(String(params[1]))) };
      if (sql.includes("INSERT INTO provider_external_jobs")) {
        // The claim took the fixture's task id in place of the generated one.
        const [, adapterVersion, idempotencyKey, inputCiphertext, inputKeyId] = params;
        db.jobs.set(db.taskId, {
          task_id: db.taskId, adapter_version: adapterVersion, idempotency_key: idempotencyKey,
          input_ciphertext: inputCiphertext, input_key_id: inputKeyId, phase: "queued",
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO provider_transactions")) {
        const [, gatewayAudience, orderId, nonce, dispatchHash, requestHash, payer, slug, skill, listing,
          , owner, leaseToken, , providerQuoteHash, state] = params;
        const row = {
          id: db.taskId, gateway_audience: gatewayAudience, order_id: orderId, dispatch_nonce: nonce,
          dispatch_hash: dispatchHash, request_hash: requestHash, payer, service_slug: slug, skill_id: skill,
          listing_manifest_hash: listing, state, result: null, result_hash: null,
          execution_owner: owner, execution_lease_token: leaseToken, provider_quote_hash: providerQuoteHash,
          created_at: new Date(db.clock * 1_000), completed_at: null, operations_revision: 0,
          operations_projection: { fulfillment: null, support: null, recovery: null },
        };
        db.claims.set(String(orderId), row);
        return { rows: observed(db, row) };
      }
      throw new Error(`unexpected transaction statement: ${sql.slice(0, 80)}`);
    },
  });
}
