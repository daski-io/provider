import { getAddress, type Address } from "viem";
import { pool } from "../pool.js";
import type { Queryable } from "../queryable.js";
import { decryptString, encryptString, protectedLookupHash } from "../../chain/encryption.js";

export interface CustomerRow {
  id: string;
  wallet_address: Address;
  first_seen_at: Date;
  last_seen_at: Date;
  last_known_email: string | null;
}

export interface AdminCustomerRow extends CustomerRow {
  transaction_count: number;
  open_review_count: number;
}

function customerEmailContext(customerId: string) {
  return {
    purpose: "customer-contact",
    table: "customers",
    recordId: customerId,
    field: "last_known_email",
  } as const;
}

function revealCustomer(row: CustomerRow): CustomerRow {
  return {
    ...row,
    last_known_email: row.last_known_email
      ? decryptString(row.last_known_email, customerEmailContext(row.id))
      : null,
  };
}

export async function upsertCustomer(
  payer: Address,
  db: Queryable = pool,
): Promise<CustomerRow> {
  const wallet = getAddress(payer).toLowerCase();
  const result = await db.query<CustomerRow>(
    `INSERT INTO customers(wallet_address) VALUES ($1)
     ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at=now()
     RETURNING *`,
    [wallet],
  );
  return revealCustomer(result.rows[0]!);
}

export async function setCustomerLastKnownEmail(
  customerId: string,
  email: string,
  db: Queryable = pool,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const result = await db.query(
    `UPDATE customers SET last_known_email=$2,last_known_email_hash=$3,last_seen_at=now()
      WHERE id=$1`,
    [customerId, encryptString(normalized, customerEmailContext(customerId)),
      protectedLookupHash(normalized, "customer-email")],
  );
  if (result.rowCount !== 1) throw new Error("customer contact update lost its owner");
}

export async function getCustomerByWallet(
  payer: Address,
  db: Queryable = pool,
): Promise<CustomerRow | null> {
  const result = await db.query<CustomerRow>(
    "SELECT * FROM customers WHERE wallet_address=$1",
    [getAddress(payer).toLowerCase()],
  );
  return result.rows[0] ? revealCustomer(result.rows[0]) : null;
}

export async function getCustomerById(
  id: string,
  db: Queryable = pool,
): Promise<CustomerRow | null> {
  const result = await db.query<CustomerRow>("SELECT * FROM customers WHERE id=$1", [id]);
  return result.rows[0] ? revealCustomer(result.rows[0]) : null;
}

export async function listCustomersForAdmin(limit = 100): Promise<AdminCustomerRow[]> {
  const result = await pool.query<AdminCustomerRow>(
    `SELECT c.*,
            count(DISTINCT t.id)::int AS transaction_count,
            count(DISTINCT e.id) FILTER (WHERE e.status IN (
              'pending','awaiting_human','resolution_queued','rejection_queued',
              'resolution_executing','resolution_result_ready','resolution_attention'
            ))::int AS open_review_count
       FROM customers c
       LEFT JOIN transactions t ON t.customer_id=c.id
       LEFT JOIN escalations e ON e.transaction_id=t.id
      GROUP BY c.id
      ORDER BY c.last_seen_at DESC,c.id DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 1_000)],
  );
  return result.rows.map((row) => revealCustomer(row) as AdminCustomerRow);
}
