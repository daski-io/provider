import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const LEGAL_URLS = [
  "MARKETPLACE_TERMS_URL",
  "MARKETPLACE_PRIVACY_URL",
  "PROVIDER_TERMS_URL",
  "PROVIDER_PRIVACY_URL",
] as const;

const VALID_VALUES: Record<(typeof LEGAL_URLS)[number], string> = {
  MARKETPLACE_TERMS_URL: "https://marketplace.test/terms-of-use",
  MARKETPLACE_PRIVACY_URL: "https://marketplace.test/privacy-policy",
  PROVIDER_TERMS_URL: "https://provider.test/terms-of-use",
  PROVIDER_PRIVACY_URL: "https://provider.test/privacy-policy",
};

function restoreValidValues(): void {
  for (const key of LEGAL_URLS) process.env[key] = VALID_VALUES[key];
}

async function reloadConfig() {
  vi.resetModules();
  return import("../src/core/config.js");
}

beforeEach(restoreValidValues);

afterAll(() => {
  restoreValidValues();
  vi.resetModules();
});

describe("legal URL configuration", () => {
  it.each(LEGAL_URLS)("requires %s", async (key) => {
    delete process.env[key];

    await expect(reloadConfig()).rejects.toThrow(key);
  });

  it.each(LEGAL_URLS)("rejects a blank %s", async (key) => {
    process.env[key] = "   ";

    await expect(reloadConfig()).rejects.toThrow(key);
  });

  it.each(LEGAL_URLS)("rejects a malformed %s", async (key) => {
    process.env[key] = "not-a-url";

    await expect(reloadConfig()).rejects.toThrow(
      "must be a valid HTTPS URL without embedded credentials",
    );
  });

  it.each(LEGAL_URLS)("requires %s to use HTTPS", async (key) => {
    process.env[key] = "http://legal.test/document";

    await expect(reloadConfig()).rejects.toThrow(
      "must be a valid HTTPS URL without embedded credentials",
    );
  });

  it.each(LEGAL_URLS)("rejects embedded credentials in %s", async (key) => {
    process.env[key] = "https://user:password@legal.test/document";

    await expect(reloadConfig()).rejects.toThrow(
      "must be a valid HTTPS URL without embedded credentials",
    );
  });

  it.each(LEGAL_URLS)("allows a privacy-notice fragment in %s", async (key) => {
    process.env[key] = "https://legal.test/combined-document#privacy";

    await expect(reloadConfig()).resolves.toBeDefined();
  });
});
