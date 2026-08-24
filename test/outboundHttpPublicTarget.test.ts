import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validatePublicUrl: vi.fn(),
  pinnedHttpRequest: vi.fn(),
}));

vi.mock("../src/core/config.js", () => ({
  config: {
    OUTBOUND_MAX_CONCURRENCY_PER_ORIGIN: 4,
    OUTBOUND_TOTAL_TIMEOUT_MS: 1_000,
    OUTBOUND_MAX_RESPONSE_BYTES: 1_024,
    OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: 3,
    OUTBOUND_CIRCUIT_OPEN_MS: 1_000,
  },
}));
vi.mock("../src/core/security/ssrf.js", () => ({
  validatePublicUrl: mocks.validatePublicUrl,
}));
vi.mock("../src/core/security/pinnedHttp.js", () => ({
  pinnedHttpRequest: mocks.pinnedHttpRequest,
}));

import { boundedFetch } from "../src/core/security/outboundHttp.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("boundedFetch public-target policy", () => {
  it("rejects private targets before opening a request", async () => {
    mocks.validatePublicUrl.mockResolvedValue({
      ok: false,
      reason: "private address",
    });

    await expect(
      boundedFetch("https://gateway.example/profile", {}, {
        publicTarget: { allowHttp: false },
      }),
    ).rejects.toThrow("outbound target rejected");

    expect(mocks.validatePublicUrl).toHaveBeenCalledWith(
      "https://gateway.example/profile",
      { allowHttp: false, allowQueryOrFragment: undefined },
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dials the address returned by the SSRF validator without re-resolving", async () => {
    mocks.validatePublicUrl.mockResolvedValue({
      ok: true,
      url: new URL("https://gateway.example/profile"),
      addresses: ["8.8.8.8"],
    });
    mocks.pinnedHttpRequest.mockResolvedValue({
      status: 200,
      statusText: "OK",
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: Buffer.from("{}"),
    });

    const response = await boundedFetch("https://gateway.example/profile", {}, {
      publicTarget: { allowHttp: false, allowQueryOrFragment: false },
      allowedContentTypes: ["application/json"],
    });

    expect(response.ok).toBe(true);
    expect(mocks.pinnedHttpRequest).toHaveBeenCalledWith(expect.objectContaining({
      pinnedIp: "8.8.8.8",
      url: new URL("https://gateway.example/profile"),
    }));
    expect(fetch).not.toHaveBeenCalled();
  });
});
