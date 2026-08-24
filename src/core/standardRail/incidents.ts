import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import type { Hex } from "viem";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export async function recordStandardSecurityIncident(args: {
  kind: string;
  gatewayAudience?: string;
  orderId?: string;
  identity: Record<string, unknown>;
  details?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO standard_security_incidents(
       incident_id,incident_kind,gateway_audience,order_id,fingerprint,details
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (incident_kind,fingerprint) DO NOTHING`,
    [randomUUID(), args.kind, args.gatewayAudience ?? null, args.orderId ?? null,
      bytes(canonicalHash(args.identity)), args.details ?? {}],
  );
}
