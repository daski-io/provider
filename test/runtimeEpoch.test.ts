import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  assertSupportedSchemaEpoch,
  RUNTIME_SCHEMA_EPOCH,
  withRuntimeEpochMarker,
} from "../src/core/db/runtimeEpoch.js";

const MARKER = `-c daski.runtime_epoch=${RUNTIME_SCHEMA_EPOCH}`;

describe("runtime-epoch marker", () => {
  it("adds the marker to a plain connection URL", () => {
    expect(withRuntimeEpochMarker("postgresql://app:secret@db.internal:5432/provider"))
      .toEqual({ connectionString: "postgresql://app:secret@db.internal:5432/provider", options: MARKER });
  });

  it("keeps options the URL already carries, since node-postgres lets the URL win", () => {
    const merged = withRuntimeEpochMarker(
      "postgresql://app:p%40ss@db.internal/provider?sslmode=verify-full&options=-c%20search_path%3Dapp",
    );
    expect(merged.options).toBe(`-c search_path=app ${MARKER}`);
    expect(merged.connectionString).not.toContain("options=");
    const parsed = new pg.Client(merged) as unknown as {
      connectionParameters: { options: string; password: string; database: string };
    };
    expect(parsed.connectionParameters.options).toBe(`-c search_path=app ${MARKER}`);
    expect(parsed.connectionParameters.password).toBe("p@ss");
    expect(parsed.connectionParameters.database).toBe("provider");
  });

  it("still marks a connection string it cannot parse as a URL", () => {
    expect(withRuntimeEpochMarker("not a url").options).toBe(MARKER);
  });
});

describe("schema epoch support", () => {
  it("accepts a database before the barrier and at this build's epoch", () => {
    expect(() => assertSupportedSchemaEpoch(0)).not.toThrow();
    expect(() => assertSupportedSchemaEpoch(RUNTIME_SCHEMA_EPOCH)).not.toThrow();
  });

  it("refuses a newer epoch before anything is mutated", () => {
    expect(() => assertSupportedSchemaEpoch(RUNTIME_SCHEMA_EPOCH + 1))
      .toThrow(/newer than this build supports .*refusing to start/);
  });
});
