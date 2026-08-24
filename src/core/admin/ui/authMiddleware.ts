import type { NextFunction, Request, Response } from "express";
import { expectedSiweUri } from "../../auth/siwe.js";
import { authorizeAdminUiSession } from "./sessionAuth.js";
import {
  clearAdminSessionCookie,
  readAdminSessionCookie,
} from "./sessionCookie.js";

interface AdminUiRequest extends Request {
  _adminWallet?: string;
  _adminSessionId?: string;
}

export async function requireAdminUiAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (["/login", "/login/nonce", "/login/verify"].includes(req.path)) {
    next();
    return;
  }
  const method = req.method.toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origin = req.get("origin");
    let requestOrigin: string | null = null;
    try {
      requestOrigin = origin ? new URL(origin).origin : null;
    } catch {
      requestOrigin = null;
    }
    if (!requestOrigin || requestOrigin !== expectedSiweUri()) {
      res.status(403).json({ error: "csrf_origin_mismatch" });
      return;
    }
  }
  const cookie = readAdminSessionCookie(req.headers.cookie ?? "");
  if (!cookie) {
    res.redirect("/admin/ui/login");
    return;
  }
  const session = await authorizeAdminUiSession(cookie);
  if (!session) {
    res.setHeader("Set-Cookie", clearAdminSessionCookie());
    res.redirect("/admin/ui/login");
    return;
  }
  const adminRequest = req as AdminUiRequest;
  adminRequest._adminWallet = session.user_label;
  adminRequest._adminSessionId = session.id;
  next();
}

export function getAdminWallet(req: Request): string | undefined {
  return (req as AdminUiRequest)._adminWallet;
}

export function shortWallet(wallet: string | undefined): string | undefined {
  return wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : undefined;
}
