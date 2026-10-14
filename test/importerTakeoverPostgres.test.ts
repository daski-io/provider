import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const target = vi.hoisted(() => {
  const name = `lite_takeover_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  if (process.env.DATABASE_URL_TEST) {
    const url = new URL(process.env.DATABASE_URL_TEST);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();
  }
  return { name };
});

import { closeMigrationPool, pool, runMigrations } from "../src/core/db/pool.js";
import { promoteRuntimeListingVersions } from "../src/core/gatewayRegistration/runtimeCatalog.js";
import { assertCandidateServicesObligations } from "../src/installRuntimeBundle.js";
import { createDisposableDatabase, describePostgres, type DisposableDatabase } from "./postgresHarness.js";
import { buildGlobalPolicyFixture, buildRuntimeHeadFixture } from "./runtimeCatalogFixture.js";
import { hash, providerWalletKey } from "./standardRailOutcomeFixture.js";

const GATEWAY = "https://gateway.example";
const previousKey = `0x${"6c".repeat(32)}` as Hex;

// L-T10: an importer run by an incompatible candidate build cannot take over
// orders it could not service.
describePostgres("runtime bundle importer takeover check", () => {
  let database: DisposableDatabase;
  let candidate: Parameters<typeof assertCandidateServicesObligations>[1];

  beforeAll(async () => {
    database = await createDisposableDatabase("lite_takeover", undefined, target.name);
    await runMigrations();
    const globalPolicy = await buildGlobalPolicyFixture();
    candidate = { gatewayAudience: GATEWAY, globalPolicy, providerControlProfileHash: hash("3") };
    const version = (epoch: string, key: Hex) => buildRuntimeHeadFixture({
      globalPolicy, serviceSlug: "dummy", skillId: "echo", listingEpoch: epoch,
      agentWallet: privateKeyToAccount(key).address,
      pricing: { USDC: { type: "one-time", fixed_amount: "10000" } },
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", minLength: 1, maxLength: 500 } },
        required: ["message"],
        additionalProperties: false,
      },
    });
    // v1 was registered under the previous wallet and then superseded by v2.
    const v1 = version("1", previousKey);
    const v2 = version("2", providerWalletKey);
    for (const head of [v1, v2]) {
      await promoteRuntimeListingVersions(GATEWAY, head.serviceId, [{
        listingId: head.listingId, listingKey: head.listingKey, skillId: head.skillId,
        paymentRequired: true, runtimeCommitmentHash: head.runtimeCommitmentHash,
        runtimeCommitment: head.runtimeCommitment, bundle: head.bundle,
      }]);
    }
    await pool.query(
      `INSERT INTO provider_transactions (
         id,gateway_audience,order_id,dispatch_nonce,dispatch_hash,request_hash,payer,
         service_slug,skill_id,listing_manifest_hash,state,dispatch_valid_before,
         execution_owner,execution_lease_token,execution_lease_expires_at
       ) VALUES ('task-v1',$1,'ord_v1',decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),
         decode(repeat('03',32),'hex'),'0x1111111111111111111111111111111111111111','dummy','echo',
         $2,'executing',now() + interval '5 minutes',gen_random_uuid(),gen_random_uuid(),
         now() + interval '1 hour')`,
      [GATEWAY, Buffer.from(v1.runtimeCommitmentHash.slice(2), "hex")],
    );
  }, 60_000);

  afterEach(() => {
    delete process.env.PROVIDER_RETAINED_WALLET_PRIVATE_KEYS;
  });

  afterAll(async () => {
    await closeMigrationPool().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await database?.drop();
  });

  it("refuses to promote while an order's version needs a key the candidate lacks", async () => {
    await expect(assertCandidateServicesObligations(GATEWAY, candidate))
      .rejects.toThrow(/obligations are not serviceable by this build: .*\(signing key not retained\)/);
  });

  it("takes over once the previous wallet key is retained", async () => {
    process.env.PROVIDER_RETAINED_WALLET_PRIVATE_KEYS = previousKey;
    await expect(assertCandidateServicesObligations(GATEWAY, candidate)).resolves.toBeUndefined();
  });
});
