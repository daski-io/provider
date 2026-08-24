import type { Request } from "express";
import { config } from "../config.js";
import { isIpInRanges } from "./rateLimit.js";

export interface TrustedRequestCountry {
  country: string;
  source: string;
  observedAt: string;
}

/** Read an edge-replaced country assertion only across the declared proxy trust boundary. */
export function trustedRequestCountry(
  req: Pick<Request, "get" | "socket">,
  now = new Date(),
): TrustedRequestCountry | null {
  const header = config.TRUSTED_REQUEST_COUNTRY_HEADER.trim().toLowerCase();
  if (!header || config.TRUST_PROXY_HOPS < 1) return null;
  const trustedCidrs = config.TRUST_PROXY_CIDRS
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const peer = req.socket.remoteAddress ?? "";
  if (!peer || !isIpInRanges(peer, trustedCidrs)) return null;
  const value = req.get(header)?.trim();
  if (!value || !/^[A-Za-z]{2}$/.test(value)) return null;
  return {
    country: value.toUpperCase(),
    source: `trusted-proxy-header:${header}`,
    observedAt: now.toISOString(),
  };
}
