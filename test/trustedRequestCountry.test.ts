import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/core/config.js";
import { trustedRequestCountry } from "../src/core/security/trustedRequestCountry.js";

const original = {
  hops: config.TRUST_PROXY_HOPS,
  cidrs: config.TRUST_PROXY_CIDRS,
  header: config.TRUSTED_REQUEST_COUNTRY_HEADER,
};

afterEach(() => {
  config.TRUST_PROXY_HOPS = original.hops;
  config.TRUST_PROXY_CIDRS = original.cidrs;
  config.TRUSTED_REQUEST_COUNTRY_HEADER = original.header;
});

function request(peer: string, value: string | undefined) {
  return {
    socket: { remoteAddress: peer },
    get: () => value,
  } as any;
}

describe("trusted request country", () => {
  it("accepts an ISO country only from the declared proxy peer", () => {
    config.TRUST_PROXY_HOPS = 1;
    config.TRUST_PROXY_CIDRS = "192.0.2.0/24";
    config.TRUSTED_REQUEST_COUNTRY_HEADER = "x-edge-country";
    expect(trustedRequestCountry(
      request("192.0.2.10", "ve"),
      new Date("2026-07-21T12:00:00.000Z"),
    )).toEqual({
      country: "VE",
      source: "trusted-proxy-header:x-edge-country",
      observedAt: "2026-07-21T12:00:00.000Z",
    });
  });

  it("ignores buyer-supplied and malformed assertions", () => {
    config.TRUST_PROXY_HOPS = 1;
    config.TRUST_PROXY_CIDRS = "192.0.2.0/24";
    config.TRUSTED_REQUEST_COUNTRY_HEADER = "x-edge-country";
    expect(trustedRequestCountry(request("198.51.100.20", "VE"))).toBeNull();
    expect(trustedRequestCountry(request("192.0.2.10", "VE,US"))).toBeNull();
    config.TRUST_PROXY_HOPS = 0;
    expect(trustedRequestCountry(request("192.0.2.10", "VE"))).toBeNull();
  });
});
