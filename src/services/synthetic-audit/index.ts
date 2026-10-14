import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceModule } from "../../core/serviceRegistry/types.js";
import { SyntheticAuditAdapter } from "./adapter.js";
import { assertSyntheticAuditAllowed } from "./config.js";
import { manifest, skills } from "./manifest.js";
import { FakeAuditUpstream, type AuditUpstream } from "./upstream.js";
import { descriptionFieldErrors } from "./validation.js";

const here = dirname(fileURLToPath(import.meta.url));
const doc = (name: string) => readFileSync(join(here, "docs", `${name}.md`), "utf8");

/**
 * The synthetic audit as an external-job service module: copy it for a
 * product that already runs paid work as its own asynchronous job. It is a
 * Testnet-only example around an in-memory fake upstream and is not
 * composed in src/providerServices.ts; tests and the offline tour build it
 * with their own clock and upstream.
 */
export function createSyntheticAuditService(options: {
  chainId: number;
  clock?: () => number;
  upstream?: AuditUpstream;
}): ServiceModule {
  assertSyntheticAuditAllowed(options.chainId);
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
  const upstream = options.upstream ?? new FakeAuditUpstream(clock);
  return {
    manifest,
    skills,
    adapter: new SyntheticAuditAdapter(upstream, clock),
    readiness: async () => true,
    // Read-only: declines before payment a description the audit cannot take.
    requestReadiness: async ({ input }) => {
      const fieldErrors = descriptionFieldErrors(input);
      return fieldErrors.length === 0 ? { ready: true } : { ready: false, fieldErrors };
    },
    failureCodes: ["audit_rejected", "invalid_input", "unknown_skill"],
    docs: {
      service: doc("index"),
      skills: { audit: doc("audit") },
    },
  };
}
