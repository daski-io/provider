import {
  concatHex,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeGzipBase64Json } from "../src/core/standardRail/compressedJson.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";

export const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
export const providerWalletKey = `0x${"44".repeat(32)}` as Hex;

export function standardOutcome(): ProviderOutcomeConfig {
  const token = "0x6666666666666666666666666666666666666666" as const;
  const providerPayee = "0x8888888888888888888888888888888888888888" as const;
  const daskiCommissionReceiver =
    "0x9999999999999999999999999999999999999999" as const;
  const splitterFactory = "0x1212121212121212121212121212121212121212" as const;
  const splitterCreationCode = "0x6000" as const;
  const splitterCreationCodeHash = keccak256(splitterCreationCode);
  const splitterDeploymentSalt = hash("f");
  const constructorArgs = encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "uint16" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
    ],
    [
      84532n, token, providerPayee, daskiCommissionReceiver, 500,
      hash("8"), hash("7"), hash("6"), 1n,
    ],
  );
  const splitterInitCodeHash = keccak256(
    concatHex([splitterCreationCode, constructorArgs]),
  );
  return {
    outcomeId: "dummy.echo.v1",
    serviceSlug: "dummy",
    serviceId: hash("0"),
    skillId: "echo",
    listingManifestHash: hash("1"),
    providerOfferHash: hash("2"),
    pricingMode: "fixed",
    fixedGrossAmount: "10000",
    quoteMaximumLifetimeSeconds: 0,
    quoteMinimumPaymentWindowSeconds: 0,
    providerControlProfileHash: hash("3"),
    activeRailProfileHash: hash("9"),
    customerIdentityPolicyId: "none",
    token,
    splitter: getCreate2Address({
      from: splitterFactory,
      salt: splitterDeploymentSalt,
      bytecodeHash: splitterInitCodeHash,
    }),
    splitterFactory,
    splitterFactoryRuntimeCodeHash: hash("3"),
    splitterCreationCode,
    splitterCreationCodeHash,
    splitterInitCodeHash,
    splitterDeploymentSalt,
    splitterRuntimeCodeHash: hash("4"),
    splitterDeploymentTransaction: hash("1"),
    splitterDeploymentBlockNumber: "123",
    splitterDeploymentBlockHash: hash("b"),
    splitterActivationBlockNumber: "123",
    splitterActivationBlockHash: hash("a"),
    splitterActivationPosition: "END_OF_BLOCK",
    splitterStartingTokenBalance: "0",
    splitterStartingReleaseSequence: "0",
    tokenRuntimeCodeHash: hash("5"),
    tokenImplementationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tokenImplementationRuntimeCodeHash: hash("a"),
    tokenImplementationSlot: hash("b"),
    tokenDomainSeparator: hash("c"),
    sanctionsOracleRuntimeCodeHash: hash("d"),
    providerControlledWallets: [],
    maximumSourceLagBlocks: 3,
    maximumLogPageEvents: 10_000,
    listingCommitmentHash: hash("6"),
    outcomeIdHash: hash("7"),
    policyVersionHash: hash("8"),
    listingEpoch: "1",
    providerPayee,
    providerTerminalAttestationKey: privateKeyToAccount(providerWalletKey).address,
    daskiCommissionReceiver,
    commissionBps: 500,
    maxOpenOrders: 10,
    dispatchDeadlineSeconds: 300,
    bindingProfile: "recipe-bound-v1",
    requestSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["message"],
      additionalProperties: false,
    },
  };
}

export function standardSplitterFixture(): ProviderOutcomeConfig {
  return standardOutcome();
}

export function standardEnvironment(): NodeJS.ProcessEnv {
  return {
    PROVIDER_WALLET_PRIVATE_KEY: providerWalletKey,
    BASE_RPC_URL: "https://rpc.example",
    BASE_RPC_FALLBACK_URLS: "",
    BASE_URL: "https://provider.example",
    GATEWAY_BASE_URL: "https://gateway.example",
    CHAIN_ID: "84532",
    USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
    SANCTIONS_ORACLE_ADDRESS: "0x5555555555555555555555555555555555555555",
    REPUTATION_STORAGE_ADDRESS: "0x4545454545454545454545454545454545454545",
    EAS_ADDRESS: "0x4646464646464646464646464646464646464646",
    EAS_RUNTIME_CODE_HASH: hash("f"),
    EAS_OUTCOME_SCHEMA_UID: hash("e"),
    STANDARD_RAIL_ENVIRONMENT: "testnet",
    STANDARD_RAIL_GATEWAY_AUDIENCE: "https://gateway.example",
    STANDARD_RAIL_PROVIDER_AUDIENCE: "https://provider.example",
    STANDARD_RAIL_GATEWAY_SIGNER: "0x4444444444444444444444444444444444444444",
    STANDARD_RAIL_OUTCOMES_JSON: encodeGzipBase64Json([standardOutcome()]),
  };
}
