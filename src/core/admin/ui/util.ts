import type { Request } from "express";

const MAX_ADMIN_FORM_BYTES = 64 * 1024;

// Shared helpers for the SIWE-gated admin UI pages. Form bodies are
// hand-parsed (no express body-parser middleware on /admin/ui/* routes —
// the SIWE login flow needs the raw request to verify the signed
// message) so every POST handler used to repeat the same data/end
// listener block. This module concentrates it.

/// Buffer the raw request body and parse it as URL-encoded form data.
/// Express does not body-parse /admin/ui POSTs (see admin/routes.ts).
export async function readFormBody(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    const error = new Error("admin form content type must be application/x-www-form-urlencoded");
    Object.assign(error, { status: 415 });
    throw error;
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_ADMIN_FORM_BYTES) {
        const error = new Error("admin form body exceeds 65536 bytes");
        Object.assign(error, { status: 413 });
        fail(error);
        return;
      }
      chunks.push(value);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("aborted", () => fail(new Error("admin form request was aborted")));
    req.on("error", (error) => fail(error));
  });
}

/// Truncate a wallet address for header display ("0x1234…abcd").
/// Returns undefined when the request has no SIWE-authenticated wallet
/// (caller redirected to /login already).
export function walletShortFromReq(req: Request): string | undefined {
  const wallet = (req as Request & { _adminWallet?: string })._adminWallet;
  return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : undefined;
}

/// The full SIWE wallet on the request (post-auth-middleware), or
/// undefined if unauthenticated. Most action handlers want both this
/// and `walletShortFromReq` — keep them together so callers stop
/// open-coding the cast.
export function walletFromReq(req: Request): string | undefined {
  return (req as Request & { _adminWallet?: string })._adminWallet;
}

/** Internal database session id used to bind consequential confirmation intents. */
export function sessionIdFromReq(req: Request): string | undefined {
  return (req as Request & { _adminSessionId?: string })._adminSessionId;
}
