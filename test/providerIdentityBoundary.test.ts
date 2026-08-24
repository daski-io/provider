import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ authorized: false }));

vi.mock("../src/core/chain/providerIdentity.js", () => ({
  getProviderIdentityAuthorization: vi.fn(() => ({
    ok: state.authorized,
  })),
}));

import { requireCurrentProviderIdentity } from "../src/core/security/providerIdentityBoundary.js";

describe("public service provider identity boundary", () => {
  const next = vi.fn();
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);

  beforeEach(() => {
    state.authorized = false;
    next.mockClear();
    response.status.mockClear();
    response.json.mockClear();
  });

  it("returns 503 when the provider identity is unavailable", () => {
    requireCurrentProviderIdentity(
      {} as never,
      response as never,
      next,
    );
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      error: "provider_identity_unavailable",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("continues only while provider identity is fresh", () => {
    state.authorized = true;
    requireCurrentProviderIdentity(
      {} as never,
      response as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });
});
