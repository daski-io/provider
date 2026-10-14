import {
  appendReviewedOperation,
  reviewedEndpoint,
} from "../../core/security/reviewedEndpoint.js";
import { isPassiveText, type JsonRecord, type RequestFieldError } from "../../core/serviceRegistry/types.js";
import { AUDIT_REVIEWED_ENDPOINT } from "./config.js";

export const MAX_DESCRIPTION_CODE_POINTS = 2_000;

/** The buyer's description, trimmed; 1 to 2,000 Unicode code points of passive text. */
export function parseDescription(value: unknown): string {
  if (typeof value !== "string") throw new Error("description must be a string");
  const description = value.trim();
  const length = [...description].length;
  if (length < 1 || length > MAX_DESCRIPTION_CODE_POINTS || !isPassiveText(description)) {
    throw new Error("description is not auditable");
  }
  return description;
}

/** Field errors for a schema-valid request the audit could not accept, before payment. */
export function descriptionFieldErrors(input: Record<string, unknown>): RequestFieldError[] {
  try {
    parseDescription(input.description);
    return [];
  } catch {
    return [{
      path: "description",
      rule: "auditable-text",
      message: "The description must contain 1 to 2000 characters without markup or control characters.",
    }];
  }
}

const JOB_ID = /^aud-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{32}$/;

/**
 * The stored job reference, `{v: 1, jobId, reportUrl}`, accepted only when
 * its bearer report URL is exactly the reviewed endpoint's report path for
 * that job (built with the reviewed-endpoint helpers) with one token: no
 * other origin, scheme, port, user info, path, fragment or parameter. Core
 * never interprets the URL; this service never follows any other one.
 */
export function parseJobReference(job: JsonRecord): { jobId: string; token: string } | null {
  if (Object.keys(job).sort().join() !== "jobId,reportUrl,v" || job.v !== 1) return null;
  if (typeof job.jobId !== "string" || !JOB_ID.test(job.jobId) || typeof job.reportUrl !== "string") return null;
  let url: URL;
  let expected: URL;
  try {
    url = new URL(job.reportUrl);
    expected = appendReviewedOperation(
      reviewedEndpoint(AUDIT_REVIEWED_ENDPOINT, AUDIT_REVIEWED_ENDPOINT),
      `jobs/${job.jobId}/report`,
    );
  } catch {
    return null;
  }
  const token = url.searchParams.get("token");
  if (
    url.protocol !== "https:" || url.username || url.password || url.hash
    || url.origin !== expected.origin || url.pathname !== expected.pathname
    || [...url.searchParams.keys()].join() !== "token" || !token || !TOKEN.test(token)
  ) return null;
  return { jobId: job.jobId, token };
}
