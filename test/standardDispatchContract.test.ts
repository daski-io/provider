import { describe, expect, it } from "vitest";
import { STANDARD_DISPATCH_PAYLOAD_KEYS } from "../src/core/standardRail/dispatchContract.js";

describe("standard dispatch contract", () => {
  it("uses the canonical buyer identity proof field", () => {
    expect(STANDARD_DISPATCH_PAYLOAD_KEYS).toContain("buyerIdentityProofHash");
    expect(STANDARD_DISPATCH_PAYLOAD_KEYS).not.toContain("customerIdentityProofHash");
  });

  it("binds the exact V2 deposit and release coordinates", () => {
    expect(STANDARD_DISPATCH_PAYLOAD_KEYS).toEqual(expect.arrayContaining([
      "settlementTxHash",
      "depositBlockNumber",
      "depositBlockHash",
      "depositTransactionIndex",
      "depositLogIndex",
      "depositEvidenceHash",
      "releaseTxHash",
      "releaseBlockNumber",
      "releaseBlockHash",
      "releaseTransactionIndex",
      "releaseLogIndex",
      "releaseSequence",
      "releaseEvidenceHash",
    ]));
    expect(new Set(STANDARD_DISPATCH_PAYLOAD_KEYS).size)
      .toBe(STANDARD_DISPATCH_PAYLOAD_KEYS.length);
  });
});
