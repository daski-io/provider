import type { Hex } from "viem";
import { logWarn } from "../logger.js";
import { parseSupplierCost, type SupplierCost } from "../serviceRegistry/supplierCost.js";
import type { RequestFieldError, ServiceModule } from "../serviceRegistry/types.js";
import { reviewedFieldErrors } from "./quoteFieldErrors.js";

export const REQUEST_READINESS_TIMEOUT_MS = 3_000;

export type QuoteReadinessVerdict =
  | { kind: "ready"; supplierCost?: SupplierCost }
  | { kind: "declined"; fieldErrors: RequestFieldError[] }
  | { kind: "unavailable" };

/**
 * Run a service's optional read-only request-readiness hook under a bounded
 * signal. A throw, timeout, or any result outside the reviewed shape is a
 * fault: no quote is issued, and nothing the hook returns can alter price.
 * A supplier price it reports must be exactly a valid `SupplierCost`; any
 * other value is the same fault, so no quote records an unreviewed ceiling.
 */
export async function checkRequestReadiness(
  service: ServiceModule,
  request: { skillId: string; input: Record<string, unknown>; payer: Hex | null },
): Promise<QuoteReadinessVerdict> {
  if (!service.requestReadiness) return { kind: "ready" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_READINESS_TIMEOUT_MS);
  timeout.unref();
  try {
    const result: unknown = await Promise.race([
      service.requestReadiness({
        skillId: request.skillId,
        input: structuredClone(request.input),
        payer: request.payer,
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => controller.signal.addEventListener(
        "abort",
        () => reject(new Error("request readiness timed out")),
        { once: true },
      )),
    ]);
    const verdict = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : {};
    const keys = Object.keys(verdict).sort().join(",");
    if (verdict.ready === true && keys === "ready") return { kind: "ready" };
    if (verdict.ready === true && keys === "ready,supplierCost") {
      const supplierCost = parseSupplierCost(verdict.supplierCost);
      if (supplierCost) return { kind: "ready", supplierCost };
    }
    if (verdict.ready === false && keys === "fieldErrors,ready") {
      const fieldErrors = reviewedFieldErrors(verdict.fieldErrors);
      if (fieldErrors) return { kind: "declined", fieldErrors };
    }
    logWarn("Request readiness returned an unreviewed result", {
      serviceSlug: service.manifest.slug,
    });
    return { kind: "unavailable" };
  } catch (error) {
    logWarn("Request readiness check failed", {
      serviceSlug: service.manifest.slug,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}
