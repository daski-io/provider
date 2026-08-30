import { describe, expect, it } from "vitest";
import { findListingCommitmentDrift } from "../src/core/gatewayRegistration/commitmentDrift.js";
import type { RuntimeListingHead } from "../src/core/gatewayRegistration/runtimeCatalog.js";

const SERVICE = `0x${"8e".repeat(32)}`;
const REGISTERED = `0x${"aa".repeat(32)}`;
const SERVED = `0x${"bb".repeat(32)}`;

function head(overrides: Partial<{
  serviceId: string;
  skillId: string;
  skillContractHash: string;
}> = {}): RuntimeListingHead {
  const skillContractHash = overrides.skillContractHash ?? REGISTERED;
  return {
    gatewayOrigin: "https://gateway.example",
    serviceId: (overrides.serviceId ?? SERVICE) as RuntimeListingHead["serviceId"],
    skillId: overrides.skillId ?? "echo",
    listingId: "17f5b863-1643-4e02-9607-fd5dd408397a",
    listingKey: `0x${"11".repeat(32)}` as RuntimeListingHead["listingKey"],
    paymentRequired: true,
    runtimeCommitmentHash:
      `0x${"22".repeat(32)}` as RuntimeListingHead["runtimeCommitmentHash"],
    runtimeCommitment: {
      skillContractHash,
    } as unknown as RuntimeListingHead["runtimeCommitment"],
    bundle: {} as RuntimeListingHead["bundle"],
    promotedAt: new Date("2026-08-28T16:08:47Z"),
  };
}

describe("findListingCommitmentDrift", () => {
  it("reports a head whose registered contract hash differs from this build", () => {
    expect(findListingCommitmentDrift(
      [head()],
      new Map([[`${SERVICE}:echo`, SERVED]]),
    )).toEqual([{
      serviceId: SERVICE,
      skillId: "echo",
      registeredSkillContractHash: REGISTERED,
      servedSkillContractHash: SERVED,
    }]);
  });

  it("matches hashes case-insensitively", () => {
    expect(findListingCommitmentDrift(
      [head({ skillContractHash: REGISTERED.toUpperCase().replace("0X", "0x") })],
      new Map([[`${SERVICE}:echo`, REGISTERED]]),
    )).toEqual([]);
  });

  it("ignores heads for skills this build does not serve", () => {
    expect(findListingCommitmentDrift(
      [head({ skillId: "retired-skill" })],
      new Map([[`${SERVICE}:echo`, SERVED]]),
    )).toEqual([]);
  });
});
