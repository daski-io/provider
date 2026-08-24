import { privateKeyToAccount } from "viem/accounts";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import type { ValidateFunction } from "ajv";
import { getServiceBySlug } from "../db/queries/services.js";
import { getAdapter } from "../serviceRegistry/registry.js";
import { pool } from "../db/pool.js";
import { assertExactKeys, canonicalHash, SIGNED_ENVELOPE_KEYS, unsignedEnvelopeHash } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { compileProviderSchema, validateProviderRequest } from "./schema.js";
import type { SignedEnvelope } from "./types.js";

interface ProviderQuoteRequest {
  outcomeId: string;
  listingManifestHash: Hex;
  requestHash: Hex;
  request: Record<string, unknown>;
}

export class StandardQuoteService {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    private readonly config: ProviderStandardRailConfig,
    private readonly chainId: number,
  ) {
    for (const outcome of config.outcomes.values()) {
      this.validators.set(outcome.outcomeId, compileProviderSchema(outcome.requestSchema));
    }
  }

  async quote(envelope: SignedEnvelope<ProviderQuoteRequest>): Promise<Record<string, unknown>> {
    assertExactKeys(envelope, SIGNED_ENVELOPE_KEYS, "quote request envelope");
    assertExactKeys(envelope.payload, [
      "outcomeId", "listingManifestHash", "requestHash", "request",
    ], "quote request payload");
    const now = Math.floor(Date.now() / 1_000);
    if (
      envelope.artifactType !== "ProviderQuoteRequestV1" || envelope.schemaVersion !== 1 ||
      envelope.environment !== this.config.environment || envelope.chainId !== this.chainId ||
      envelope.audience !== this.config.providerAudience || envelope.issuedAt > now + 30 ||
      envelope.validBefore <= now || envelope.validBefore > now + 120
    ) throw new Error("Quote request envelope is invalid");
    const signer = await recoverMessageAddress({
      message: { raw: unsignedEnvelopeHash(envelope as unknown as Record<string, unknown>) },
      signature: envelope.signature,
    });
    if (getAddress(signer) !== this.config.gatewayDispatchSigner) {
      throw new Error("Quote request signature is invalid");
    }
    const args = envelope.payload;
    const outcome = this.config.outcomes.get(args.outcomeId);
    if (
      !outcome || outcome.listingManifestHash !== args.listingManifestHash ||
      outcome.pricingMode !== "dynamic" || canonicalHash(args.request) !== args.requestHash
    ) throw new Error("Quote request binding is invalid");
    const validate = this.validators.get(args.outcomeId);
    if (!validate) throw new Error("Quote outcome schema is unavailable");
    validateProviderRequest(validate, args.request);
    const service = await getServiceBySlug(outcome.serviceSlug);
    if (!service?.is_active) throw new Error("Quote service unavailable");
    const result = await getAdapter(service.adapter_name).quote(outcome.skillId, args.request);
    const commissionBps = BigInt(outcome.commissionBps);
    const minimumReleasableAmount = (10_000n + commissionBps - 1n) / commissionBps;
    if (!result.ok || result.amount < minimumReleasableAmount) {
      throw new Error("Provider cannot quote a releasable amount for this request");
    }
    const issuedAt = now;
    const payload = {
      outcomeId: outcome.outcomeId,
      listingManifestHash: outcome.listingManifestHash,
      requestHash: args.requestHash,
      grossAmount: result.amount.toString(),
      issuedAt,
      validBefore: issuedAt + outcome.quoteMaximumLifetimeSeconds,
    };
    await pool.query(
      `INSERT INTO standard_provider_quotes
        (quote_hash,outcome_id,listing_manifest_hash,request_hash,gross_amount,
         supplier_cost_ceiling,issued_at,valid_before)
       VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8))
       ON CONFLICT (quote_hash) DO NOTHING`,
      [
        Buffer.from(canonicalHash(payload).slice(2), "hex"), outcome.outcomeId,
        Buffer.from(outcome.listingManifestHash.slice(2), "hex"),
        Buffer.from(args.requestHash.slice(2), "hex"), payload.grossAmount,
        result.supplierCostCeiling ?? null, payload.issuedAt, payload.validBefore,
      ],
    );
    const signature = await privateKeyToAccount(this.config.providerAuthorityPrivateKey).signMessage({
      message: { raw: canonicalHash(payload) },
    });
    return { ...payload, signature };
  }
}
