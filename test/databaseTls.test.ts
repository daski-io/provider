import { describe, expect, it } from "vitest";
import {
  assertVerifiedTlsForDatabaseMutation,
  databaseTlsConfig,
  parseDatabaseSslMode,
} from "../src/core/db/tls.js";

describe("database TLS configuration", () => {
  it("allows explicit plaintext only for loopback mutation targets", () => {
    expect(() => assertVerifiedTlsForDatabaseMutation(
      "postgresql://user:pass@localhost:5432/provider",
      "disable",
    )).not.toThrow();
  });

  it("builds verified TLS with normalized CA material", () => {
    expect(databaseTlsConfig("verify-full", "line-1\\nline-2")).toEqual({
      rejectUnauthorized: true,
      ca: "line-1\nline-2",
    });
  });

  it("uses system trust when verify-full has no private CA", () => {
    expect(databaseTlsConfig("verify-full")).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("rejects remote mutation targets without certificate verification", () => {
    for (const url of [
      "postgresql://user:pass@db.example.com/provider",
      "postgresql://user:pass@localhost.attacker.example/provider",
      "postgresql://user:pass@railway.internal.attacker.example/provider",
    ]) {
      expect(() => assertVerifiedTlsForDatabaseMutation(url, "require")).toThrow(
        "Remote database mutations require DATABASE_SSL_MODE=verify-full",
      );
    }
  });

  it("requires scripts to make the TLS mode explicit", () => {
    expect(() => parseDatabaseSslMode(undefined)).toThrow("DATABASE_SSL_MODE");
    expect(parseDatabaseSslMode("verify-full")).toBe("verify-full");
  });
});
