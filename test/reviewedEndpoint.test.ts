import { describe, expect, it } from "vitest";
import {
  appendReviewedOperation,
  reviewedEndpoint,
} from "../src/core/security/reviewedEndpoint.js";

const REVIEWED = "https://api.vendor.com/v1";

describe("reviewed supplier endpoints", () => {
  it("normalizes the exact reviewed base as a directory", () => {
    expect(reviewedEndpoint(REVIEWED, REVIEWED).toString()).toBe(
      "https://api.vendor.com/v1/",
    );
    expect(
      reviewedEndpoint("https://API.VENDOR.COM/v1/", REVIEWED).toString(),
    ).toBe("https://api.vendor.com/v1/");
  });

  it.each([
    "http://api.vendor.com/v1",
    "https://api.vendor.com.evil.example/v1",
    "https://evil-api.vendor.com/v1",
    "https://user:pass@api.vendor.com/v1",
    "https://api.vendor.com:8443/v1",
    "https://api.vendor.com/v2",
    "https://api.vendor.com/v1?next=evil",
    "https://api.vendor.com/v1#fragment",
    "https://api.vendor.com/%2e%2e/v1",
  ])("rejects an unreviewed base: %s", (value) => {
    expect(() => reviewedEndpoint(value, REVIEWED)).toThrow();
  });

  it("preserves the reviewed base path when appending an operation", () => {
    const endpoint = appendReviewedOperation(
      reviewedEndpoint(REVIEWED, REVIEWED),
      "checkIndividual",
    );
    endpoint.searchParams.set("names", "Controlled Subject");
    expect(endpoint.toString()).toBe(
      "https://api.vendor.com/v1/checkIndividual?names=Controlled+Subject",
    );
  });

  it.each([
    "/absolute",
    "//attacker.example/path",
    "../escape",
    "path?query=1",
    "path#fragment",
    "path/%2e%2e/escape",
    "path%2fescape",
  ])("rejects an unsafe operation path: %s", (operation) => {
    expect(() =>
      appendReviewedOperation(
        reviewedEndpoint(REVIEWED, REVIEWED),
        operation,
      )).toThrow();
  });
});
