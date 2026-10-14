import express, { type NextFunction, type Request, type Response } from "express";
import { assertNoDuplicateJsonKeys } from "../standardRail/canonical.js";
import { isServicingRequest, servicingPath } from "./servicingIngress.js";

type RawBodyRequest = Request & { rawBody?: Buffer };

const captureRawBody = (req: Request, _res: Response, body: Buffer) => {
  (req as RawBodyRequest).rawBody = body;
};

/// Only UTF-8 bodies are accepted: the duplicate-key and nesting scan reads
/// the raw bytes as UTF-8, and any other charset would be decoded differently
/// by the parser after that scan.
function isPlainUtf8Json(header: string | undefined): boolean {
  const [mediaType, ...parameters] = (header ?? "").split(";").map((part) => part.trim().toLowerCase());
  if (mediaType !== "application/json") return false;
  return parameters.every((parameter) =>
    parameter === "" || parameter === "charset=utf-8" || parameter === 'charset="utf-8"');
}

/**
 * Strict request transport for /standard-rail POSTs (C01): bounded,
 * uncompressed UTF-8 `application/json`, with duplicate keys and pathological
 * documents rejected before any handler runs. These refusals are definite:
 * the request never reached a handler, so nothing was admitted. A refused
 * dispatch or status call is reported to the abuse limiter. A lifecycle call
 * is not: the gateway forwards the buyer's own `request` object in it, so an
 * oversized or unsafe one proves nothing about the sender.
 */
export function strictJsonTransport(options: { recordServicingFailure?: (req: Request) => void } = {}) {
  // Status queries and lifecycle calls are small signed envelopes; only a
  // dispatch carries a buyer request and its evidence bundle.
  const parsers = {
    small: express.json({ limit: "64kb", inflate: false, verify: captureRawBody }),
    other: express.json({ limit: "2mb", inflate: false, verify: captureRawBody }),
  };
  const refuse = (req: Request, res: Response, status: number, error: string) => {
    if (isServicingRequest(req) && servicingPath(req) !== "lifecycle") {
      options.recordServicingFailure?.(req);
    }
    res.status(status).json({ error });
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "POST") {
      next();
      return;
    }
    const encoding = req.header("content-encoding")?.trim().toLowerCase();
    if (!isPlainUtf8Json(req.header("content-type")) || (encoding && encoding !== "identity")) {
      refuse(req, res, 415, "uncompressed_application_json_required");
      return;
    }
    const kind = servicingPath(req);
    const parser = kind === "status" || kind === "lifecycle" ? parsers.small : parsers.other;
    parser(req, res, (error?: unknown) => {
      if (error) {
        const tooLarge = (error as { status?: unknown }).status === 413;
        refuse(req, res, tooLarge ? 413 : 400, tooLarge ? "payload_too_large" : "invalid_json");
        return;
      }
      try {
        const body = (req as RawBodyRequest).rawBody;
        if (body?.length) assertNoDuplicateJsonKeys(body.toString("utf8"));
      } catch {
        refuse(req, res, 400, "invalid_json");
        return;
      }
      next();
    });
  };
}
