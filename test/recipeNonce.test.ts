import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { recipeNonce, recipeNonceV2 } from "../src/core/standardRail/canonical.js";

// The recipe nonce is the EIP-3009 authorization nonce a buyer signs, a
// protocol constant shared with the gateway and the buyer client, so this is
// the buyer client's (`@daski/x402-scheme`) pinned recipe-bound-v2 vector.
const binding = {
  runtimeCommitmentHash: "0xc88b484c75bcc3df77278434824f84ac6a5d9a317c6261d12a61b34cd38be41c" as Hex,
  providerIntentHash: "0x4cb5b871bba078060c24d5bc905538f5cd9e5775bc66401b886f5f4d0bf8faeb" as Hex,
  quoteHash: "0x71ef5567e186cd50e882941dfbb4b81260e30d29c3edaa5ffd10292a2dc52662" as Hex,
  canonicalRequestHash: "0xb6b24dbe4fea483e3b207aeef4a00a345850ca1fb5f4380eb59c37d9c28f3e44" as Hex,
  orderNonce: "0xcc7ec5d4c2f8b742f1321cd491a33cddf718c47174230a2010ed0cab67ab2266" as Hex,
};
const facts = {
  chainId: 84532,
  canonicalToken: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
  payer: "0x1111111111111111111111111111111111111111" as Address,
  splitter: "0xE25be9CAAa546a55b2a2e8aF812E8Db51E3eDfd1" as Address,
  grossAmount: 9_990_000n,
};

describe("recipe nonces", () => {
  it("derives the recipe-bound-v2 nonce buyers sign", () => {
    expect(recipeNonceV2({ ...facts, ...binding }))
      .toBe("0xa2fe873efb98107270107019a13434f7b65e84269d0ea5047b20b7a009525911");
  });

  it("keeps the v1 and v2 domains apart for the same slots", () => {
    expect(recipeNonce({
      ...facts,
      listingManifestHash: binding.runtimeCommitmentHash,
      providerOfferHash: binding.providerIntentHash,
      quoteHash: binding.quoteHash,
      canonicalRequestHash: binding.canonicalRequestHash,
      orderNonce: binding.orderNonce,
    })).not.toBe(recipeNonceV2({ ...facts, ...binding }));
  });
});
