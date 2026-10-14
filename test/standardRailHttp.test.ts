import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), claims: new Map<string, unknown>() }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: { query: db.query, connect: vi.fn() },
  checkDatabase: async () => true,
}));

import { config } from "../src/core/config.js";
import { setProviderIdentityStatus, setRailStatus } from "../src/core/health.js";
import { createApp } from "../src/core/server.js";
import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import type { QuoteV1 } from "../src/core/standardRail/types.js";
import { dispatchOrder } from "./gatewayOrderFixture.js";
import {
  acceptDispatchSnapshotAsGateway,
  acceptIntakeAsGateway,
  acceptQuoteAsGateway,
  classifyDispatchAnswer,
  classifyStatusAnswer,
  gatewayIntakeRequest,
  gatewayQuoteRequest,
  gatewayStatusQuery,
  nowSeconds,
  signGatewayEnvelope,
} from "./gatewayWire.js";
import { echoService, gatewayListing, railConfig, railOutcome } from "./standardRailServiceFixture.js";

const listing = gatewayListing();
const payer = `0x${"ab".repeat(20)}` as Hex;
const request = { message: "hello" };
let server: Server;
let origin: string;

async function post(path: string, body: string | Uint8Array, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : new Blob([new Uint8Array(body)]),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: () => JSON.parse(text) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  server = createApp(railConfig()).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const answerQuery = async (sql: string, params: unknown[] = []) => {
  if (String(sql).includes("count(*)")) return { rows: [{ count: "0" }] };
  if (String(sql).includes("WHERE gateway_audience=$1 AND order_id=$2")) {
    const claim = db.claims.get(String(params[1]));
    return { rows: claim ? [claim] : [] };
  }
  return { rows: [{ tokens: 1 }], rowCount: 1 };
};

beforeEach(() => {
  db.claims.clear();
  db.query.mockReset().mockImplementation(answerQuery);
  clearServicesForTests();
  registerService(echoService());
  setProviderIdentityStatus(true);
  setRailStatus(true);
});

describe("quote URL over HTTP", () => {
  it("answers bounded, uncompressed JSON the gateway accepts", async () => {
    const body = JSON.stringify({ request: await gatewayQuoteRequest({ listing, request, payer }) });
    const response = await post("/standard-rail/quote", body);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(acceptQuoteAsGateway({ listing, body: response.json(), request, payer }))
      .resolves.toBeDefined();
  });

  it("answers signed intake discovery on the same URL", async () => {
    const body = JSON.stringify({ request: await gatewayIntakeRequest(listing, request) });
    const response = await post("/standard-rail/quote", body);
    expect(response.status).toBe(200);
    await expect(acceptIntakeAsGateway(listing, request, response.json()))
      .resolves.toMatchObject({ fieldErrors: [], supported: null });
  });

  it("uses exact bounded refusal bodies", async () => {
    expect((await post("/standard-rail/quote", JSON.stringify({}))).json())
      .toEqual({ error: "invalid_quote_request" });
    const envelope = await gatewayQuoteRequest({ listing, request, payer });
    const forged = await post("/standard-rail/quote", JSON.stringify({
      request: { ...envelope, signature: `0x${"11".repeat(65)}` },
    }));
    expect([forged.status, forged.json()])
      .toEqual([401, { error: "quote_rejected", reason: "signature" }]);
    const invalid = await post("/standard-rail/quote", JSON.stringify({
      request: await gatewayQuoteRequest({ listing, request: {}, payer }),
    }));
    expect(invalid.status).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: "quote_rejected",
      reason: "request_invalid",
      fieldErrors: [expect.objectContaining({ path: "message", rule: "required" })],
    });
    db.query.mockImplementation(async (sql: string) =>
      String(sql).includes("count(*)") ? { rows: [{ count: "10" }] } : { rows: [{ tokens: 1 }], rowCount: 1 });
    const full = await post("/standard-rail/quote", JSON.stringify({ request: envelope }));
    expect([full.status, full.headers.get("retry-after"), full.json()])
      .toEqual([503, "30", { error: "quote_unavailable", reason: "capacity" }]);
  });

  it("rejects duplicate keys, oversized nesting, compressed bodies, and other media types", async () => {
    const envelope = JSON.stringify(await gatewayQuoteRequest({ listing, request, payer }));
    const duplicate = await post("/standard-rail/quote", `{"request":${envelope},"request":${envelope}}`);
    expect([duplicate.status, duplicate.json()]).toEqual([400, { error: "invalid_json" }]);
    const deep = await post("/standard-rail/quote", `${"[".repeat(70)}${"]".repeat(70)}`);
    expect([deep.status, deep.json()]).toEqual([400, { error: "invalid_json" }]);
    const compressed = await post(
      "/standard-rail/quote",
      gzipSync(JSON.stringify({ request: JSON.parse(envelope) })),
      { "content-encoding": "gzip" },
    );
    expect([compressed.status, compressed.json()])
      .toEqual([415, { error: "uncompressed_application_json_required" }]);
    const text = await post("/standard-rail/quote", envelope, { "content-type": "text/plain" });
    expect(text.status).toBe(415);
    const malformed = await post("/standard-rail/quote", "{");
    expect([malformed.status, malformed.json()]).toEqual([400, { error: "invalid_json" }]);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("provider_quotes"))).toBe(false);
  });

  it("stops new quotes while the provider is not ready", async () => {
    setRailStatus(false);
    const body = JSON.stringify({ request: await gatewayQuoteRequest({ listing, request, payer }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await post("/standard-rail/quote", body);
    expect(response.status).toBe(503);
  });
});

const dispatchHash = `0x${"5e".repeat(32)}` as Hex;
const orderId = "ord_00000000-0000-4000-8000-0000000000c1";
function admittedClaim() {
  db.claims.set(orderId, {
    id: "task-http",
    gateway_audience: "https://gateway.example",
    order_id: orderId,
    dispatch_hash: Buffer.from(dispatchHash.slice(2), "hex"),
    state: "executing",
    result: null,
    completed_at: null,
    operations_revision: 0,
    operations_projection: { fulfillment: null, support: null, recovery: null },
    observed_at: String(nowSeconds()),
  });
}
const toAnswer = (response: Awaited<ReturnType<typeof post>>) => ({
  status: response.status,
  contentType: response.headers.get("content-type"),
  contentEncoding: response.headers.get("content-encoding"),
  text: response.text,
});
const rateLimitCalls = () => db.query.mock.calls
  .filter(([sql]) => String(sql).includes("rate_limit_buckets")).length;

async function signedDispatchBody() {
  const outcome = railOutcome();
  const now = nowSeconds();
  const quote = await signGatewayEnvelope<QuoteV1>({
    artifactType: "QuoteV1", audience: "https://gateway.example", signerKeyId: "gateway-quote",
    issuedAt: now, validBefore: now + 120,
    payload: {
      listingManifestHash: outcome.listingManifestHash, providerOfferHash: outcome.providerOfferHash,
      providerQuoteHash: `0x${"71".repeat(32)}` as Hex, canonicalRequestHash: `0x${"72".repeat(32)}` as Hex,
      grossAmount: "10000", token: outcome.token, splitter: outcome.splitter,
      orderNonce: `0x${"73".repeat(32)}` as Hex, issuedAt: now, validBefore: now + 120,
    },
  });
  return dispatchOrder({
    order: {
      orderId: `ord_${globalThis.crypto.randomUUID()}`, request, payer: `0x${"Ab".repeat(20)}` as Hex,
      quote, providerQuoteHash: quote.payload.providerQuoteHash, orderNonce: quote.payload.orderNonce,
      position: 1,
    },
    outcome,
    config: railConfig(),
  });
}

describe("servicing calls over HTTP", () => {
  it("serves status while sales are not ready and never touches rate-limit buckets", async () => {
    admittedClaim();
    setRailStatus(false);
    const answer = await post("/standard-rail/dispatch/status", JSON.stringify({
      query: await gatewayStatusQuery(orderId, dispatchHash),
    }));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    await expect(acceptDispatchSnapshotAsGateway({ value: answer.json(), dispatchHash }))
      .resolves.toMatchObject({ body: { state: "working" } });
    expect(rateLimitCalls()).toBe(0);
    const quote = await post("/standard-rail/quote", JSON.stringify({
      request: await gatewayQuoteRequest({ listing, request, payer }),
    }));
    expect(quote.status).toBe(503);
  });

  it("answers transport faults on servicing calls ambiguously, never with a JSON refusal", async () => {
    const { body } = await signedDispatchBody();
    const text = JSON.stringify(body);
    const faults: Array<[string, string | Uint8Array, Record<string, string>]> = [
      ["/standard-rail/dispatch", `{"dispatch":1,${text.slice(1)}`, {}],
      ["/standard-rail/dispatch", gzipSync(text), { "content-encoding": "gzip" }],
      ["/standard-rail/dispatch", text, { "content-type": "text/plain" }],
      ["/standard-rail/dispatch", "{", {}],
      ["/standard-rail/dispatch/status", JSON.stringify({ query: {}, padding: "x".repeat(70_000) }), {}],
      ["/STANDARD-RAIL/DISPATCH/", "{", {}],
    ];
    for (const [path, payload, headers] of faults) {
      const answer = toAnswer(await post(path, payload, headers));
      expect([answer.status, answer.text, answer.contentType]).toEqual([503, "", null]);
      expect(classifyDispatchAnswer(answer)).toBe("ambiguous");
    }
  });

  it("refuses only before admission and answers an unreadable claim ambiguously", async () => {
    const malformed = await post("/standard-rail/dispatch", JSON.stringify({ dispatch: {} }));
    expect([malformed.status, malformed.json()])
      .toEqual([400, { error: "dispatch_rejected", reason: "validator" }]);
    const { body } = await signedDispatchBody();
    const forged = await post("/standard-rail/dispatch", JSON.stringify({
      ...body, dispatch: { ...(body.dispatch as object), signature: `0x${"11".repeat(65)}` },
    }));
    expect([forged.status, forged.json()])
      .toEqual([401, { error: "dispatch_rejected", reason: "signature" }]);
    for (const envelope of [
      await gatewayStatusQuery(orderId, dispatchHash),
      await gatewayQuoteRequest({ listing, request, payer }),
    ]) {
      const crossType = await post("/standard-rail/dispatch", JSON.stringify({ ...body, dispatch: envelope }));
      expect(crossType.status).toBe(400);
      expect(crossType.json()).toEqual({ error: "dispatch_rejected", reason: "validator" });
    }
    db.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes("WHERE gateway_audience=$1 AND order_id=$2")) {
        throw new Error("database unavailable");
      }
      return answerQuery(sql, params);
    });
    const unreadable = toAnswer(await post("/standard-rail/dispatch", JSON.stringify(body)));
    expect(classifyDispatchAnswer(unreadable)).toBe("ambiguous");
    const status = toAnswer(await post("/standard-rail/dispatch/status", JSON.stringify({
      query: await gatewayStatusQuery(orderId, dispatchHash),
    })));
    expect([status.status, classifyStatusAnswer(status)]).toEqual([503, "unavailable"]);
  });
});

describe("servicing ingress limits", () => {
  const saved = {
    HTTP_MAX_CONCURRENCY: config.HTTP_MAX_CONCURRENCY,
    HTTP_MAX_CONCURRENCY_PER_IP: config.HTTP_MAX_CONCURRENCY_PER_IP,
    RATE_LIMIT_BYPASS_IPS: config.RATE_LIMIT_BYPASS_IPS,
  };
  let limited: Server;
  let limitedOrigin: string;
  const start = async (overrides: Partial<typeof saved>) => {
    Object.assign(config, overrides);
    limited = createApp(railConfig()).listen(0, "127.0.0.1");
    await once(limited, "listening");
    limitedOrigin = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
  };
  const limitedPost = async (path: string, body: unknown) => {
    const response = await fetch(`${limitedOrigin}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  const stop = async () => {
    Object.assign(config, saved);
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  };

  it("answers servicing calls ambiguously when the concurrency budget is full", async () => {
    await start({ HTTP_MAX_CONCURRENCY: 1, HTTP_MAX_CONCURRENCY_PER_IP: 1 });
    try {
      admittedClaim();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      db.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (String(sql).includes("WHERE gateway_audience=$1 AND order_id=$2")) await held;
        return answerQuery(sql, params);
      });
      const query = { query: await gatewayStatusQuery(orderId, dispatchHash) };
      const first = limitedPost("/standard-rail/dispatch/status", query);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await limitedPost("/standard-rail/dispatch/status", query)).toEqual({ status: 503, text: "" });
      expect(await limitedPost("/standard-rail/dispatch", {})).toEqual({ status: 503, text: "" });
      const quote = await limitedPost("/standard-rail/quote", { request: {} });
      expect([quote.status, JSON.parse(quote.text)]).toEqual([503, { error: "server_busy" }]);
      release();
      expect((await first).status).toBe(200);
    } finally {
      await stop();
    }
  });

  it("throttles sources of unauthenticated servicing failures but never verified reads", async () => {
    await start({});
    try {
      admittedClaim();
      const valid = { query: await gatewayStatusQuery(orderId, dispatchHash) };
      for (let read = 0; read < 150; read += 1) {
        expect((await limitedPost("/standard-rail/dispatch/status", valid)).status).toBe(200);
      }
      const forged = { query: { ...valid.query, signature: `0x${"11".repeat(65)}` } };
      for (let attempt = 0; attempt < 120; attempt += 1) {
        expect((await limitedPost("/standard-rail/dispatch/status", forged)).status).toBe(401);
      }
      expect(await limitedPost("/standard-rail/dispatch/status", valid)).toEqual({ status: 503, text: "" });
      expect(rateLimitCalls()).toBe(0);
    } finally {
      await stop();
    }
    await start({ RATE_LIMIT_BYPASS_IPS: "127.0.0.1" });
    try {
      const forged = { query: { ...(await gatewayStatusQuery(orderId, dispatchHash)), signature: "0x00" } };
      for (let attempt = 0; attempt < 121; attempt += 1) {
        expect((await limitedPost("/standard-rail/dispatch/status", forged)).status).toBe(401);
      }
    } finally {
      await stop();
    }
  }, 60_000);
});
