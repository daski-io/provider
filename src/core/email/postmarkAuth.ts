import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { config } from "../config.js";

function safeEqualString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function authorizePostmark(req: Request): boolean {
  const secrets = [
    config.POSTMARK_INBOUND_WEBHOOK_SECRET,
    config.POSTMARK_INBOUND_WEBHOOK_SECRET_PREVIOUS,
  ].filter((value): value is string => Boolean(value));
  if (secrets.length === 0) return false;

  const authorization = req.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(
      authorization.slice(6).trim(),
      "base64",
    ).toString("utf8");
    const separator = decoded.indexOf(":");
    const user = separator >= 0 ? decoded.slice(0, separator) : decoded;
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";
    if (
      secrets.some(
        (secret) =>
          safeEqualString(password, secret) ||
          safeEqualString(user, secret),
      )
    ) {
      return true;
    }
  }

  const signature = (req.get("x-postmark-signature") ?? "").trim();
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (signature && rawBody) {
    for (const secret of secrets) {
      const expected = createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");
      try {
        if (
          timingSafeEqual(
            Buffer.from(signature, "hex"),
            Buffer.from(expected, "hex"),
          )
        ) {
          return true;
        }
      } catch {
        return false;
      }
    }
  }
  return false;
}
