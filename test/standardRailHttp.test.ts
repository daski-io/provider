import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: { query: db.query, connect: vi.fn() },
  checkDatabase: async () => true,
}));

import { setProviderIdentityStatus, setRailStatus } from "../src/core/health.js";
import { createApp } from "../src/core/server.js";
import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import {
  acceptIntakeAsGateway,
  acceptQuoteAsGateway,
  gatewayIntakeRequest,
  gatewayQuoteRequest,
} from "./gatewayWire.js";
import { echoService, gatewayListing, railConfig } from "./standardRailServiceFixture.js";

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

beforeEach(() => {
  db.query.mockReset().mockImplementation(async (sql: string) =>
    String(sql).includes("count(*)") ? { rows: [{ count: "0" }] } : { rows: [{ tokens: 1 }], rowCount: 1 });
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
