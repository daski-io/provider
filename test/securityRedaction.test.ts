import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/core/security/redaction.js";

describe("security text redaction", () => {
  it("removes credentials, signed URLs, RPC keys, JWTs, and PII", () => {
    const input = [
      "Bearer bearer-secret-value",
      "Basic dXNlcjpwYXNzd29yZA==",
      "https://rpc.example/v2/real-api-key?token=secret",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
      "password=hunter2 api_key='live-key'",
      "person@example.com 123-45-6789",
    ].join(" ");
    const output = redactSensitiveText(input);
    for (const sentinel of [
      "bearer-secret-value", "dXNlcjpwYXNzd29yZA", "real-api-key", "token=secret",
      "eyJhbGci", "hunter2", "live-key", "person@example.com", "123-45-6789",
    ]) {
      expect(output).not.toContain(sentinel);
    }
    expect(output).toContain("https://rpc.example/<redacted:url>");
  });

  it("keeps public chain identifiers while removing labeled signed payloads", () => {
    const transactionHash = `0x${"ab".repeat(32)}`;
    const signedTransaction = `0x${"cd".repeat(120)}`;
    const output = redactSensitiveText(
      `transaction hash ${transactionHash}; serialized transaction=${signedTransaction}`,
    );
    expect(output).toContain(transactionHash);
    expect(output).not.toContain(signedTransaction);
    expect(output).toContain("serialized transaction=<redacted:payload>");
  });

  it("redacts camel-case serialized transaction fields in provider errors", () => {
    const serialized = `0x${"ab".repeat(120)}`;
    const output = redactSensitiveText(
      `RPC rejected serializedTransaction: ${serialized}`,
    );
    expect(output).toContain("serializedTransaction=<redacted:payload>");
    expect(output).not.toContain(serialized);
  });
});
