import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

interface IpRange {
  version: 4 | 6;
  network: bigint;
  prefix: number;
}

function normalizeIp(value: string): string {
  let ip = value.trim().replace(/^\[|\]$/g, "").split("%", 1)[0];
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip;
}

function parseIp(value: string): { version: 4 | 6; value: bigint } | null {
  const ip = normalizeIp(value);
  const version = isIP(ip);
  if (version === 4) {
    return {
      version: 4,
      value: ip.split(".").map(Number).reduce(
        (total, part) => (total << 8n) | BigInt(part),
        0n,
      ),
    };
  }
  if (version !== 6) return null;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] => {
    if (!half) return [];
    return half.split(":").flatMap((group) => {
      if (!group.includes(".")) return [Number.parseInt(group, 16)];
      const v4 = parseIp(group);
      if (!v4 || v4.version !== 4) return [Number.NaN];
      return [Number((v4.value >> 16n) & 0xffffn), Number(v4.value & 0xffffn)];
    });
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? "");
  const omitted = 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (
    omitted < 0 || (halves.length === 1 && omitted !== 0)
    || groups.length !== 8
    || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)
  ) return null;
  return {
    version: 6,
    value: groups.reduce((total, group) => (total << 16n) | BigInt(group), 0n),
  };
}

function parseRange(value: string): IpRange {
  const [rawAddress, rawPrefix] = value.trim().split("/");
  const parsed = parseIp(rawAddress ?? "");
  if (!parsed) throw new Error(`invalid IP/CIDR '${value}'`);
  const bits = parsed.version === 4 ? 32 : 128;
  const prefix = rawPrefix === undefined ? bits : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new Error(`invalid IP/CIDR prefix '${value}'`);
  }
  const shift = BigInt(bits - prefix);
  return {
    version: parsed.version,
    prefix,
    network: shift === 0n ? parsed.value : (parsed.value >> shift) << shift,
  };
}

export function isIpInRanges(ip: string, ranges: string[]): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return ranges.some((raw) => {
    const range = parseRange(raw);
    if (range.version !== parsed.version) return false;
    const shift = BigInt((range.version === 4 ? 32 : 128) - range.prefix);
    return (shift === 0n ? parsed.value : (parsed.value >> shift) << shift) === range.network;
  });
}

export function requestClientIp(req: Request): string {
  return normalizeIp(req.ip || req.socket.remoteAddress || "unknown");
}

export function makeRateLimiter(options: {
  namespace: string;
  capacity: number;
  perMinute: number;
  bypassIps?: string[];
}) {
  if (options.capacity <= 0 || options.perMinute <= 0) {
    throw new Error(`Invalid rate limiter: ${options.namespace}`);
  }
  const bypass = options.bypassIps ?? [];
  bypass.forEach(parseRange);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = requestClientIp(req);
    if (isIpInRanges(ip, bypass)) return next();
    const identity = createHmac("sha256", config.RATE_LIMIT_HASH_KEY)
      .update(`${options.namespace}\0${ip}`)
      .digest("hex");
    try {
      const result = await pool.query(
        `INSERT INTO rate_limit_buckets (bucket_key,tokens,last_refill,expires_at)
         VALUES ($1,$2::double precision-1,now(),now()+interval '10 minutes')
         ON CONFLICT (bucket_key) DO UPDATE
           SET tokens=LEAST($2::double precision,
                 rate_limit_buckets.tokens
                 + EXTRACT(EPOCH FROM (now()-rate_limit_buckets.last_refill))
                   * ($3::double precision/60.0))-1,
               last_refill=now(),expires_at=now()+interval '10 minutes'
         WHERE LEAST($2::double precision,
                 rate_limit_buckets.tokens
                 + EXTRACT(EPOCH FROM (now()-rate_limit_buckets.last_refill))
                   * ($3::double precision/60.0))>=1
         RETURNING tokens`,
        [`${options.namespace}:${identity}`, options.capacity, options.perMinute],
      );
      if (result.rowCount !== 1) {
        const retryAfter = Math.max(1, Math.ceil(60 / options.perMinute));
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({ error: "rate_limit_exceeded", retryAfter });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "rate_limit_store_unavailable" });
    }
  };
}
