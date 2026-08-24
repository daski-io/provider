import { closeMigrationPool } from "../db/pool.js";
import { rotateProtectedData, scanProtectedData } from "./protectedDataRotation.js";

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

/**
 * Protected-data rotation CLI body. Invoked by the composition entrypoint
 * `src/rotateProtectedData.ts`, which registers every installed service's
 * protected-data sinks first — running this against core sinks alone would
 * fail the completeness scan on any service-owned envelope column.
 */
export async function runProtectedDataRotationCli(): Promise<void> {
  try {
    if (process.argv.includes("--scan")) {
      const scan = await scanProtectedData();
      process.stdout.write(`${JSON.stringify(scan)}\n`);
      if (scan.unknownEnvelopeColumns.length > 0) process.exitCode = 2;
    } else if (process.argv.includes("--rotate")) {
      const fromKeyId = option("from-key-id");
      if (!fromKeyId) throw new Error("--rotate requires --from-key-id=<key-id>");
      const result = await rotateProtectedData({ fromKeyId, runId: option("run-id") });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (process.argv.includes("--verify-retirement")) {
      const keyId = option("key-id");
      if (!keyId) throw new Error("--verify-retirement requires --key-id=<key-id>");
      const scan = await scanProtectedData();
      if (scan.unknownEnvelopeColumns.length > 0 || (scan.keyCounts[keyId] ?? 0) > 0) {
        throw new Error(`key '${keyId}' cannot be retired; protected values or unknown sinks remain`);
      }
      process.stdout.write(`${JSON.stringify({ keyId, safeToRetire: true, scan })}\n`);
    } else {
      throw new Error(
        "use --scan, --rotate --from-key-id=<id> [--run-id=<uuid>], or --verify-retirement --key-id=<id>",
      );
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await closeMigrationPool();
  }
}
