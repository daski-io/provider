import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pool } from "../pool.js";

export const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

export interface SessionRow {
  id: string;
  token_hash: Buffer;
  user_label: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date;
}

export interface CreatedSession {
  session: SessionRow;
  token: string;
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function validLifetime(expiresAt: Date): boolean {
  const lifetime = expiresAt.getTime() - Date.now();
  return lifetime > 0 && lifetime <= MAX_SESSION_LIFETIME_MS;
}

/** Create a session while returning the bearer exactly once. */
export async function createSession(
  walletAddress: string,
  expiresAt: Date,
): Promise<CreatedSession> {
  if (!WALLET_RE.test(walletAddress)) {
    throw new Error("session wallet must be a 20-byte hexadecimal address");
  }
  if (!validLifetime(expiresAt)) {
    throw new Error("session expiry must be in the future and no more than 24 hours away");
  }
  const token = newToken();
  const result = await pool.query(
    `INSERT INTO sessions (token_hash, user_label, expires_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [tokenHash(token), walletAddress.toLowerCase(), expiresAt],
  );
  return { session: result.rows[0] as SessionRow, token };
}

/** Resolve and touch an opaque bearer token. The database never stores it. */
export async function getActiveSession(token: string): Promise<SessionRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const hash = tokenHash(token);
  const result = await pool.query(
    `UPDATE sessions
        SET last_seen_at = now()
      WHERE token_hash = $1 AND expires_at > now()
        AND created_at <= now()
        AND expires_at <= created_at + interval '24 hours'
      RETURNING *`,
    [hash],
  );
  const row = result.rows[0] as SessionRow | undefined;
  if (!row || row.token_hash.length !== hash.length || !timingSafeEqual(row.token_hash, hash)) {
    return null;
  }
  return row;
}

export async function deleteSession(token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash(token)]);
}

export async function revokeAllSessions(walletAddress: string): Promise<number> {
  const result = await pool.query(
    `DELETE FROM sessions WHERE lower(user_label) = lower($1)`,
    [walletAddress],
  );
  return result.rowCount ?? 0;
}

export async function purgeExpiredSessions(): Promise<number> {
  const result = await pool.query(`DELETE FROM sessions WHERE expires_at <= now()`);
  return result.rowCount ?? 0;
}
