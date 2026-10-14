import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withRuntimeEpochMarker } from "../src/core/db/runtimeEpoch.js";
import {
  acceptQuoteAsGateway,
  classifyStatusAnswer,
  gatewayQuoteRequest,
  providerAuthority,
  providerKey,
  signGatewayEnvelope,
} from "./gatewayWire.js";
import {
  createDisposableDatabase,
  createDisposableRole,
  databaseUrl,
  describePostgres,
  type DisposableDatabase,
  type DisposableRole,
} from "./postgresHarness.js";
import {
  buildGlobalPolicyFixture,
  buildRuntimeHeadFixture,
  encodeGlobalPolicy,
  testGatewaySigner,
} from "./runtimeCatalogFixture.js";

const inputSchema = {
  type: "object",
  properties: { message: { type: "string", minLength: 1, maxLength: 500 } },
  required: ["message"],
  additionalProperties: false,
};

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// L-T19: boot the real entrypoint under separate migration and runtime
// principals (loopback mock chain mode, fully offline), then serve a quote
// against the promoted runtime catalog as the restricted runtime role.
describePostgres("provider entrypoint booted under production database roles", () => {
  let migrator: DisposableRole;
  let runtime: DisposableRole;
  let database: DisposableDatabase;
  let env: NodeJS.ProcessEnv;
  let origin: string;
  let child: ChildProcess | null = null;

  async function boot(): Promise<string> {
    const logs: string[] = [];
    child = spawn(process.execPath, ["--import=tsx", "src/bootstrap.ts"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr!.on("data", (chunk) => logs.push(String(chunk)));
    const started = Date.now();
    while (!logs.join("").includes("Server listening")) {
      if (child.exitCode !== null || Date.now() - started > 45_000) {
        throw new Error(`provider did not start: ${logs.join("").slice(-2_000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return logs.join("");
  }

  async function stop(): Promise<void> {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await once(child, "exit");
    child = null;
  }

  beforeAll(async () => {
    migrator = await createDisposableRole("lite_boot_migrator");
    runtime = await createDisposableRole("lite_boot_runtime");
    database = await createDisposableDatabase("lite_boot", migrator.name);
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    env = {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      PORT: String(port),
      BASE_URL: origin,
      GATEWAY_BASE_URL: "https://gateway.example",
      CHAIN_MODE: "mock",
      PROVIDER_NAME: "Role Boot Provider",
      MARKETPLACE_TERMS_URL: "https://marketplace.test/terms",
      MARKETPLACE_PRIVACY_URL: "https://marketplace.test/privacy",
      PROVIDER_TERMS_URL: "https://provider.test/terms",
      PROVIDER_PRIVACY_URL: "https://provider.test/privacy",
      SUPPORT_EMAIL: "support@provider.test",
      DATABASE_URL: databaseUrl(database.name, runtime),
      MIGRATION_DATABASE_URL: databaseUrl(database.name, migrator),
      DATABASE_SSL_MODE: "disable",
      CHAIN_ID: "84532",
      BASE_RPC_URL: "https://rpc.example",
      PROVIDER_WALLET_PRIVATE_KEY: providerKey,
      PROVIDER_AGENT_ID: "8327",
      IDENTITY_REGISTRY_ADDRESS: "0x1111111111111111111111111111111111111111",
      USDC_ADDRESS: "0x6666666666666666666666666666666666666666",
      RATE_LIMIT_HASH_KEY: "testing-only-rate-limit-key-with-entropy-1234567890",
      STANDARD_RAIL_ENVIRONMENT: "testnet",
      STANDARD_RAIL_GATEWAY_SIGNER: testGatewaySigner,
      STANDARD_RAIL_GATEWAY_ORIGIN: "https://gateway.example",
      STANDARD_RAIL_GATEWAY_AUDIENCE: "https://gateway.example",
      STANDARD_RAIL_GLOBAL_POLICY_JSON: encodeGlobalPolicy(await buildGlobalPolicyFixture()),
      STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH: `0x${"3".repeat(64)}`,
      SANCTIONS_ORACLE_ADDRESS: "0x5555555555555555555555555555555555555555",
      REPUTATION_STORAGE_ADDRESS: "0x4545454545454545454545454545454545454545",
      EAS_ADDRESS: "0x4646464646464646464646464646464646464646",
      EAS_RUNTIME_CODE_HASH: `0x${"f".repeat(64)}`,
      EAS_OUTCOME_SCHEMA_UID: `0x${"e".repeat(64)}`,
    };
  }, 60_000);

  afterAll(async () => {
    await stop();
    await database?.drop();
    await runtime?.drop();
    await migrator?.drop();
  });

  it("migrates, grants, verifies separation, and serves the promoted catalog", async () => {
    await boot();
    await stop();
    const globalPolicy = JSON.parse(env.STANDARD_RAIL_GLOBAL_POLICY_JSON!);
    const head = buildRuntimeHeadFixture({
      globalPolicy,
      serviceSlug: "dummy",
      skillId: "echo",
      providerAgentId: "8327",
      agentWallet: privateKeyToAccount(providerKey).address,
      pricing: { USDC: { type: "one-time", fixed_amount: "10000" } },
      inputSchema,
    });
    // An operator session states this build's runtime epoch, as the importer does.
    const owner = new pg.Client(withRuntimeEpochMarker(databaseUrl(database.name, migrator)));
    await owner.connect();
    try {
      await owner.query(
        `INSERT INTO provider_runtime_listing_versions
           (id,gateway_origin,service_id,skill_id,listing_id,listing_key,payment_required,
            runtime_commitment_hash,runtime_commitment,bundle)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,true,$6,$7,$8)`,
        [
          head.gatewayOrigin, Buffer.from(head.serviceId.slice(2), "hex"), head.skillId,
          head.listingId, Buffer.from(head.listingKey.slice(2), "hex"),
          Buffer.from(head.runtimeCommitmentHash.slice(2), "hex"),
          head.runtimeCommitment, head.bundle,
        ],
      );
    } finally {
      await owner.end();
    }

    await boot();
    expect((await fetch(`${origin}/health/ready`)).status).toBe(200);
    const outcomes = await (await fetch(`${origin}/standard-rail/outcomes`)).json() as {
      outcomes: Array<{ outcomeId: string; listingManifestHash: string }>;
    };
    expect(outcomes.outcomes).toEqual([expect.objectContaining({
      outcomeId: "echo",
      listingManifestHash: head.runtimeCommitmentHash,
    })]);
    const listing = {
      outcomeId: "echo",
      listingManifestHash: head.runtimeCommitmentHash,
      fixedGrossAmount: "10000",
      commissionBps: 500,
      providerAuthorityKey: providerAuthority,
      minimumPaymentWindowSeconds: 30,
      requestSchema: inputSchema,
    };
    const request = { message: "boot" };
    const quote = await fetch(`${origin}/standard-rail/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: await gatewayQuoteRequest({
          listing, request, payer: null, overrides: { audience: origin },
        }),
      }),
    });
    expect(quote.status).toBe(200);
    await expect(acceptQuoteAsGateway({ listing, body: await quote.json(), request, payer: null }))
      .resolves.toBeDefined();
    const now = Math.floor(Date.now() / 1_000);
    const query = await signGatewayEnvelope({
      artifactType: "DispatchStatusQueryV1",
      audience: origin,
      issuedAt: now,
      validBefore: now + 60,
      payload: {
        orderId: `ord_${globalThis.crypto.randomUUID()}`,
        dispatchHash: `0x${"42".repeat(32)}`,
        issuedAt: now,
        validBefore: now + 60,
      },
    });
    const status = await fetch(`${origin}/standard-rail/dispatch/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    expect(classifyStatusAnswer({
      status: status.status,
      contentType: status.headers.get("content-type"),
      contentEncoding: null,
      text: await status.text(),
    })).toBe("no_claim");
    const asRuntime = new pg.Client({ connectionString: databaseUrl(database.name, runtime) });
    await asRuntime.connect();
    try {
      const quotes = await asRuntime.query("SELECT count(*)::int AS count FROM provider_quotes");
      expect(quotes.rows[0].count).toBe(1);
      await expect(asRuntime.query("DELETE FROM provider_runtime_listing_versions"))
        .rejects.toThrow(/permission denied/);
    } finally {
      await asRuntime.end();
    }
  }, 120_000);
});
