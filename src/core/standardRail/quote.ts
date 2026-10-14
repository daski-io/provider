import type { ValidateFunction } from "ajv";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getService, getSkill } from "../serviceRegistry/registry.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { describeIntake } from "./intake.js";
import { QuoteRefusal, QuoteUnavailable } from "./quoteErrors.js";
import { schemaFieldErrors } from "./quoteFieldErrors.js";
import { checkRequestReadiness } from "./quoteReadiness.js";
import {
  authenticateQuotedRequest,
  boundQuotedRequest,
  resolveQuotedOutcome,
} from "./quoteRequest.js";
import {
  countOpenObligations,
  persistProviderQuote,
  type ProviderQuotePayload,
} from "./quoteStore.js";
import { salesStopFor } from "./salesStops.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";

/**
 * A fixed readiness quote lives 120 seconds: well above the gateway's
 * strictly-greater 30-second payment window measured at receipt, with
 * network margin, and below its 300-second fixed-quote maximum.
 */
export const FIXED_QUOTE_LIFETIME_SECONDS = 120;
const QUOTE_PAYLOAD_KEYS = [
  "outcomeId", "listingManifestHash", "requestHash", "request", "payer",
] as const;

interface ProviderQuoteRequestV1 {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  request: unknown;
  payer: Hex | null;
}

export type ProviderDigestSigner = (digest: Hex) => Promise<Hex>;

export class StandardQuoteService {
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly sign: ProviderDigestSigner;

  constructor(
    private readonly config: ProviderStandardRailConfig,
    private readonly chainId: number,
    options: { sign?: ProviderDigestSigner } = {},
  ) {
    for (const outcome of config.outcomes.values()) {
      this.validators.set(
        outcome.listingManifestHash,
        compileProviderSchema(outcome.requestSchema as unknown as Record<string, unknown>),
      );
    }
    const authority = privateKeyToAccount(config.providerAuthorityPrivateKey);
    this.sign = options.sign ?? ((digest) => authority.signMessage({ message: { raw: digest } }));
  }

  /** The admitted quote URL answers both readiness quotes and intake discovery. */
  async handle(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (request.artifactType === "ProviderIntakeRequestV1") {
      return describeIntake({
        value: request,
        config: this.config,
        chainId: this.chainId,
        validator: (listingManifestHash) => this.validator(listingManifestHash),
        sign: this.sign,
      });
    }
    return this.quote(request);
  }

  /**
   * Answer a signed fixed readiness quote. It never starts, reserves, or
   * purchases product work; the persisted row lets a later funded dispatch
   * prove the exact request, payer, listing, amount, and window it binds.
   */
  async quote(value: unknown): Promise<Record<string, unknown>> {
    const envelope = await authenticateQuotedRequest<ProviderQuoteRequestV1>({
      kind: "quote",
      value,
      artifactType: "ProviderQuoteRequestV1",
      payloadKeys: QUOTE_PAYLOAD_KEYS,
      config: this.config,
      chainId: this.chainId,
    });
    const args = envelope.payload;
    if (args.payer !== null && (typeof args.payer !== "string" || !/^0x[0-9a-f]{40}$/.test(args.payer))) {
      throw new QuoteRefusal("quote", 409, "binding");
    }
    const outcome = resolveQuotedOutcome("quote", this.config, args.outcomeId, args.listingManifestHash);
    const request = boundQuotedRequest("quote", args.request, args.requestHash);
    const validate = this.validator(outcome.listingManifestHash);
    try {
      validateProviderRequest(validate, request);
    } catch {
      throw new QuoteRefusal("quote", 422, "request_invalid", schemaFieldErrors(validate.errors));
    }
    const service = getService(outcome.serviceSlug);
    const skill = getSkill(outcome.serviceSlug, outcome.skillId);
    if (!service || !skill) throw new QuoteRefusal("quote", 409, "outcome_policy");
    if (skill.acceptingNewOrders === false) throw new QuoteUnavailable("sales_paused");
    // The served contract (price included) no longer matches the admitted
    // one: stop selling this version until a replacement bundle is installed.
    const stop = salesStopFor(outcome.listingManifestHash);
    if (stop) throw new QuoteUnavailable(stop);
    if (skill.fixedPriceAtomic !== outcome.fixedGrossAmount) {
      throw new QuoteRefusal("quote", 409, "outcome_policy");
    }
    const bps = BigInt(outcome.commissionBps);
    if (BigInt(outcome.fixedGrossAmount) < (10_000n + bps - 1n) / bps) {
      throw new QuoteRefusal("quote", 409, "price");
    }
    if (await countOpenObligations(outcome.listingManifestHash) >= outcome.maxOpenOrders) {
      throw new QuoteUnavailable("capacity");
    }
    const readiness = await checkRequestReadiness(service, {
      skillId: outcome.skillId,
      input: request,
      payer: args.payer,
    });
    if (readiness.kind === "declined") {
      throw new QuoteRefusal("quote", 422, "request_invalid", readiness.fieldErrors);
    }
    if (readiness.kind === "unavailable") throw new QuoteUnavailable("service_unavailable");
    const issuedAt = Math.floor(Date.now() / 1_000);
    const payload: ProviderQuotePayload = {
      outcomeId: args.outcomeId,
      listingManifestHash: args.listingManifestHash,
      requestHash: args.requestHash,
      grossAmount: outcome.fixedGrossAmount,
      payer: args.payer,
      issuedAt,
      validBefore: issuedAt + FIXED_QUOTE_LIFETIME_SECONDS,
    };
    const quoteHash = await persistProviderQuote(payload, outcome.fulfillmentSeconds);
    return { ...payload, signature: await this.sign(quoteHash) };
  }

  private validator(listingManifestHash: Hex): ValidateFunction {
    const validate = this.validators.get(listingManifestHash);
    if (!validate) throw new Error("Provider request validator is unavailable");
    return validate;
  }
}
