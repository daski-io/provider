import express, { type NextFunction, type Request, type Response } from "express";
import { assertNoDuplicateJsonKeys } from "../standardRail/canonical.js";
import { rejectRequest, servicingPath } from "./servicingIngress.js";

type RawBodyRequest = Request & { rawBody?: Buffer };

const captureRawBody = (req: Request, _res: Response, body: Buffer) => {
  (req as RawBodyRequest).rawBody = body;
};

/**
 * Strict request transport for /standard-rail POSTs (C01): bounded,
 * uncompressed `application/json`, with duplicate keys and pathological
 * documents rejected before any handler runs. A servicing call that fails
 * here is answered ambiguously rather than with a JSON refusal, because an
 * unparsed request cannot prove that no admitted work exists.
 */
export function strictJsonTransport() {
  const parsers = {
    status: express.json({ limit: "64kb", inflate: false, verify: captureRawBody }),
    other: express.json({ limit: "2mb", inflate: false, verify: captureRawBody }),
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "POST") {
      next();
      return;
    }
    const mediaType = req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const encoding = req.header("content-encoding")?.trim().toLowerCase();
    if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
      rejectRequest(req, res, 415, "uncompressed_application_json_required");
      return;
    }
    const parser = servicingPath(req) === "status" ? parsers.status : parsers.other;
    parser(req, res, (error?: unknown) => {
      if (error) {
        const tooLarge = (error as { status?: unknown }).status === 413;
        rejectRequest(req, res, tooLarge ? 413 : 400, tooLarge ? "payload_too_large" : "invalid_json");
        return;
      }
      try {
        const body = (req as RawBodyRequest).rawBody;
        if (body?.length) assertNoDuplicateJsonKeys(body.toString("utf8"));
      } catch {
        rejectRequest(req, res, 400, "invalid_json");
        return;
      }
      next();
    });
  };
}
