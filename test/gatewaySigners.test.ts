import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyGatewayRequestEnvelope } from "../src/core/standardRail/gatewayEnvelope.js";
import {
  artifactGatewaySigners,
  parseGatewaySigners,
  registrationGatewaySigners,
  runtimeGatewaySigners,
  trustsGatewaySigner,
} from "../src/core/standardRail/gatewaySigners.js";
import { gatewayKey, gatewaySigner, nowSeconds, signGatewayEnvelope } from "./gatewayWire.js";

const current = getAddress("0x1111111111111111111111111111111111111111");
const previous = getAddress("0x2222222222222222222222222222222222222222");
const release = getAddress("0x3333333333333333333333333333333333333333");

describe("gateway signer rotation settings", () => {
  it("defaults to one signer for runtime envelopes and release artifacts", () => {
    const signers = parseGatewaySigners({ STANDARD_RAIL_GATEWAY_SIGNER: current.toLowerCase() });
    expect(signers).toEqual({ current, previous: null, artifacts: [current] });
    expect(runtimeGatewaySigners(signers.current, signers.previous)).toEqual([current]);
    expect(artifactGatewaySigners({ gatewayDispatchSigner: signers.current })).toEqual([current]);
  });

  it("keeps the previous runtime signer and the earlier artifact signers apart", () => {
    const signers = parseGatewaySigners({
      STANDARD_RAIL_GATEWAY_SIGNER: current,
      STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS: previous,
      STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: ` ${previous}, ${release} `,
    });
    const config = {
      gatewayDispatchSigner: signers.current,
      gatewayPreviousSigner: signers.previous,
      gatewayArtifactSigners: signers.artifacts,
    };
    expect(runtimeGatewaySigners(config.gatewayDispatchSigner, config.gatewayPreviousSigner)).toEqual([current, previous]);
    expect(artifactGatewaySigners(config)).toEqual([previous, release]);
    expect(trustsGatewaySigner(runtimeGatewaySigners(config.gatewayDispatchSigner, config.gatewayPreviousSigner), release))
      .toBe(false);
    expect(trustsGatewaySigner(artifactGatewaySigners(config), current)).toBe(false);
    expect(registrationGatewaySigners(signers)).toEqual([current, previous, release]);
  });

  it("accepts any letter case for a trusted signer", () => {
    expect(trustsGatewaySigner([current], current.toLowerCase() as `0x${string}`)).toBe(true);
  });

  it.each([
    [{}, /STANDARD_RAIL_GATEWAY_SIGNER is required/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: "0x1234" }, /non-zero address/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: `0x${"0".repeat(40)}` }, /non-zero address/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: current, STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS: current.toLowerCase() }, /repeats/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: current, STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS: "previous" }, /non-zero address/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: current, STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: `${previous},` }, /entry 2/],
    [{ STANDARD_RAIL_GATEWAY_SIGNER: current, STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: `${previous},${previous.toLowerCase()}` }, /duplicate/],
    [{
      STANDARD_RAIL_GATEWAY_SIGNER: current,
      STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS: Array.from({ length: 9 }, (_, index) =>
        `0x${(index + 1).toString(16).padStart(40, "0")}`).join(","),
    }, /at most 8/],
  ])("refuses malformed settings %#", (env, message) => {
    expect(() => parseGatewaySigners(env as NodeJS.ProcessEnv)).toThrow(message);
  });
});

describe("gateway runtime envelopes during a rotation", () => {
  const rotatedKey = `0x${"56".repeat(32)}` as Hex;
  const rotated = privateKeyToAccount(rotatedKey).address;

  async function statusQuery(privateKey: Hex) {
    const issuedAt = nowSeconds();
    return signGatewayEnvelope({
      artifactType: "DispatchStatusQueryV1",
      issuedAt,
      validBefore: issuedAt + 60,
      payload: { orderId: "order-1" },
      privateKey,
    });
  }

  const expected = (signers: readonly Address[]) => ({
    artifactType: "DispatchStatusQueryV1",
    payloadKeys: ["orderId"],
    environment: "testnet",
    chainId: 84532,
    audience: "https://provider.example",
    signers,
  });

  it("accepts the previous signer only while it is configured", async () => {
    const fromPrevious = await statusQuery(gatewayKey);
    await expect(verifyGatewayRequestEnvelope(fromPrevious, expected(runtimeGatewaySigners(rotated))))
      .rejects.toThrow(/signature is invalid/);
    await expect(verifyGatewayRequestEnvelope(fromPrevious, expected(runtimeGatewaySigners(rotated, gatewaySigner))))
      .resolves.toMatchObject({ payload: { orderId: "order-1" } });
    await expect(verifyGatewayRequestEnvelope(await statusQuery(rotatedKey), expected(runtimeGatewaySigners(rotated, gatewaySigner))))
      .resolves.toMatchObject({ payload: { orderId: "order-1" } });
  });
});
