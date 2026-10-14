import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn(), tasks: new Map<string, unknown>() }));
vi.mock("../src/core/db/pool.js", () => ({
  pool: { query: db.query, connect: vi.fn() },
  checkDatabase: async () => true,
}));

import { setProviderIdentityStatus, setRailStatus } from "../src/core/health.js";
import { createApp } from "../src/core/server.js";
import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { PayerRpcEndpoint } from "../src/core/standardRail/payerRpc.js";
import type { ProviderTransaction } from "../src/core/standardRail/transactionStore.js";
import {
  acceptLifecycleAnswerAsGateway,
  classifyLifecycleRefusal,
  gatewayLifecycleCall,
  LIFECYCLE_HEADERS,
  payerAuthorization,
} from "./gatewayLifecycleWire.js";
import { nowSeconds, signGatewayEnvelope, type ProviderAnswer } from "./gatewayWire.js";
import { echoResultSchema } from "./standardRailOutcomeFixture.js";
import { echoService, railConfig } from "./standardRailServiceFixture.js";

const payerKey = `0x${"5a".repeat(32)}` as Hex;
const payer = privateKeyToAccount(payerKey).address;
const otherKey = `0x${"5b".repeat(32)}` as Hex;
const order = (suffix: string) => `ord_00000000-0000-4000-8000-0000000000${suffix}`;
const echo = {
  status: "completed" as const,
  message: "Echo completed.",
  artifacts: [{ name: "echo_result", mimeType: "application/json", data: { message: "hi" } }],
};
const frozen = (value: unknown) => Buffer.from(canonicalHash(value).slice(2), "hex");
const contractAnswer = { kind: "returned" as const, data: `0x1626ba7e${"0".repeat(56)}` as Hex };

function task(id: string, orderId: string, overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    id,
    gateway_audience: "https://gateway.example",
    order_id: orderId,
    dispatch_hash: Buffer.alloc(32, 7),
    payer,
    service_slug: "dummy",
    skill_id: "echo",
    state: "executing",
    result: null,
    result_hash: null,
    created_at: new Date((nowSeconds() - 900) * 1_000),
    completed_at: null,
    operations_revision: 0,
    operations_projection: { fulfillment: null, support: null, recovery: null },
    observed_at: String(nowSeconds()),
    ...overrides,
  };
}

const TASKS = {
  working: task("task-working", order("01")),
  completed: task("task-completed", order("02"), {
    state: "completed", result: echo, result_hash: frozen(echo),
    completed_at: new Date((nowSeconds() - 600) * 1_000),
  }),
  failed: task("task-failed", order("03"), {
    state: "failed", result: { status: "failed", errorCode: "invalid_input" },
    result_hash: frozen({ status: "failed", errorCode: "invalid_input" }),
    completed_at: new Date((nowSeconds() - 600) * 1_000),
  }),
};

let server: Server;
let origin: string;
let contractEndpoint: PayerRpcEndpoint & { calls: number; down: boolean };

async function post(body: unknown, headers: Record<string, string> = LIFECYCLE_HEADERS): Promise<ProviderAnswer> {
  const response = await fetch(`${origin}/standard-rail/lifecycle`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentEncoding: response.headers.get("content-encoding"),
    text: await response.text(),
  };
}
const json = (answer: ProviderAnswer) => JSON.parse(answer.text) as Record<string, unknown>;
const lookups = () => db.query.mock.calls.filter(([sql]) =>
  String(sql).includes("FROM provider_transactions")).length;

const readCall = (target: ProviderTransaction, action: string, extra = {}) => gatewayLifecycleCall({
  orderId: target.order_id, providerTaskId: target.id, action, payer: target.payer, ...extra,
});
const signedCall = async (target: ProviderTransaction, action: string, request = {}, key = payerKey) =>
  gatewayLifecycleCall({
    orderId: target.order_id, providerTaskId: target.id, action, payer: target.payer, request,
    authorization: await payerAuthorization({ payerKey: key, orderId: target.order_id, action, request }),
  });
const accept = (answer: ProviderAnswer, target: ProviderTransaction, action: "status" | "artifact") =>
  acceptLifecycleAnswerAsGateway({
    value: json(answer), action, orderId: target.order_id, providerTaskId: target.id,
    resultSchema: echoResultSchema(),
  });

beforeAll(async () => {
  contractEndpoint = {
    host: "rpc.example",
    calls: 0,
    down: false,
    async getCode() {
      contractEndpoint.calls += 1;
      if (contractEndpoint.down) throw new Error("connect ECONNREFUSED");
      return "0x6080";
    },
    async isValidSignature() {
      return contractAnswer;
    },
  };
  server = createApp(railConfig(), {
    lifecycle: { payerSignatures: { accountTypes: new Set(["eoa", "contract"]), endpoints: [contractEndpoint] } },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  db.tasks.clear();
  for (const value of Object.values(TASKS)) {
    db.tasks.set(value.order_id, { ...value, observed_at: String(nowSeconds()) });
  }
  db.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (String(sql).includes("WHERE gateway_audience=$1 AND order_id=$2")) {
      const found = db.tasks.get(String(params[1]));
      return { rows: found ? [found] : [] };
    }
    return { rows: [{ tokens: 1 }], rowCount: 1 };
  });
  contractEndpoint.calls = 0;
  contractEndpoint.down = false;
  clearServicesForTests();
  registerService(echoService());
  setProviderIdentityStatus(true);
  setRailStatus(true);
});

describe("lifecycle reads under both authorization forms (C-T03)", () => {
  it("answers status for a working task with a fresh signed envelope and no result", async () => {
    for (const body of [await readCall(TASKS.working, "status"), await signedCall(TASKS.working, "status")]) {
      const answer = await post(body);
      expect([answer.status, answer.contentType, answer.contentEncoding])
        .toEqual([200, "application/json; charset=utf-8", null]);
      const accepted = await accept(answer, TASKS.working, "status");
      expect(accepted.body).toMatchObject({ state: "working" });
      expect(accepted.body).not.toHaveProperty("result");
      expect(accepted.body).not.toHaveProperty("terminalAttestation");
    }
  });

  it("delivers the frozen result as the artifact and attests its frozen identity", async () => {
    const completedAt = Math.floor(TASKS.completed.completed_at!.getTime() / 1_000);
    for (const body of [
      await readCall(TASKS.completed, "artifact"),
      await signedCall(TASKS.completed, "artifact"),
    ]) {
      const answer = await post(body);
      const accepted = await accept(answer, TASKS.completed, "artifact");
      expect(accepted.body.result).toEqual(echo);
      expect(accepted.attestation).toEqual({
        orderId: TASKS.completed.order_id,
        taskId: TASKS.completed.id,
        state: "completed",
        resultHash: canonicalHash(echo),
        completedAt,
      });
    }
    const status = await accept(await post(await readCall(TASKS.completed, "status")), TASKS.completed, "status");
    expect(status.body).not.toHaveProperty("result");
    expect(status.attestation?.resultHash).toBe(canonicalHash(echo));
  });

  it("verifies a deployed contract account through the bounded ERC-1271 path", async () => {
    // Signed by a key that is not the payer's EOA: only the contract answer can admit it.
    const answer = await post(await signedCall(TASKS.working, "status", {}, otherKey));
    expect(answer.status).toBe(200);
    expect(contractEndpoint.calls).toBe(1);
    contractEndpoint.down = true;
    const unavailable = await post(await signedCall(TASKS.working, "status", {}, otherKey));
    expect([unavailable.status, json(unavailable)]).toEqual([503, { error: "lifecycle_unavailable" }]);
    expect(classifyLifecycleRefusal("status", unavailable)).toBe("PROVIDER_LIFECYCLE_UNAVAILABLE");
  });

  it("answers an artifact read before completion with exactly artifact_unavailable", async () => {
    for (const target of [TASKS.working, TASKS.failed]) {
      const answer = await post(await readCall(target, "artifact"));
      expect([answer.status, answer.text]).toEqual([409, '{"error":"artifact_unavailable"}']);
      expect(classifyLifecycleRefusal("artifact", answer)).toBe("ARTIFACT_NOT_AVAILABLE");
    }
  });

  it("refuses forged, stale, misaddressed and cross-order grants before any lookup", async () => {
    const forgedKey = `0x${"66".repeat(32)}` as Hex;
    const issuedAt = nowSeconds();
    for (const body of [
      await readCall(TASKS.working, "status", { grant: { privateKey: forgedKey } }),
      await readCall(TASKS.working, "status", { grant: { signerKeyId: "gateway-dispatch" } }),
      await readCall(TASKS.working, "status", { issuedAt: issuedAt - 121 }),
      await readCall(TASKS.working, "status", { grant: { validBefore: issuedAt + 121 } }),
      await readCall(TASKS.working, "status", { grant: { audience: "https://other-provider.example" } }),
      await readCall(TASKS.working, "status", { grant: { artifactType: "DispatchStatusQueryV1" } }),
    ]) {
      const answer = await post(body);
      expect(answer.status, answer.text).toBe(401);
      expect(classifyLifecycleRefusal("status", answer)).toBe("INTERNAL_ERROR");
    }
    const crossOrder = await readCall(TASKS.working, "status");
    const bindings = [
      { ...crossOrder, orderId: TASKS.completed.order_id },
      { ...crossOrder, providerTaskId: TASKS.completed.id },
      { ...crossOrder, request: { extra: true } },
      { ...crossOrder, payer: "0x1111111111111111111111111111111111111111" },
      { ...crossOrder, gatewayAudience: "https://other-gateway.example" },
    ];
    for (const body of bindings) {
      const answer = await post(body);
      expect([answer.status, json(answer).reason], JSON.stringify(body).slice(0, 80))
        .toEqual([403, "binding"]);
    }
    expect(lookups()).toBe(0);
    // A grant for one order naming another order's task finds no such task.
    const mixed = await gatewayLifecycleCall({
      orderId: TASKS.working.order_id, providerTaskId: TASKS.completed.id, action: "status", payer,
    });
    expect([(await post(mixed)).status]).toEqual([404]);
  });

  it("never lets a read capability or a foreign signature authorize anything else", async () => {
    for (const action of ["cancel", "input", "support"]) {
      const answer = await post(await gatewayLifecycleCall({
        orderId: TASKS.working.order_id, providerTaskId: TASKS.working.id, action, payer,
        authorization: { type: "DaskiReadCap", scope: action },
      }));
      expect([answer.status, json(answer)]).toEqual([403, { error: "lifecycle_rejected", reason: "authorization" }]);
    }
    for (const authorization of [
      { type: "DaskiReadCap", scope: "artifact" },
      { type: "DaskiReadCap", scope: "status", extra: 1 },
    ]) {
      const answer = await post(await gatewayLifecycleCall({
        orderId: TASKS.working.order_id, providerTaskId: TASKS.working.id, action: "status", payer,
        authorization,
      }));
      expect(answer.status).toBe(403);
    }
    const otherAudience = await gatewayLifecycleCall({
      orderId: TASKS.working.order_id, providerTaskId: TASKS.working.id, action: "status", payer,
      authorization: await payerAuthorization({
        payerKey, orderId: TASKS.working.order_id, action: "status", request: {},
        audience: "https://other-gateway.example",
      }),
    });
    const eoaOnly = createApp(railConfig()).listen(0, "127.0.0.1");
    await once(eoaOnly, "listening");
    try {
      const answer = await fetch(`http://127.0.0.1:${(eoaOnly.address() as AddressInfo).port}/standard-rail/lifecycle`, {
        method: "POST", headers: LIFECYCLE_HEADERS, body: JSON.stringify(otherAudience),
      });
      expect([answer.status, await answer.json()]).toEqual([403, { error: "lifecycle_rejected", reason: "authorization" }]);
    } finally {
      await new Promise<void>((resolve) => eoaOnly.close(() => resolve()));
    }
  });

  it("answers unsupported mutations with exactly unsupported_action and no effect (L-T13)", async () => {
    for (const [action, request] of [
      ["cancel", {}],
      ["input", { inputText: "Keep the title.", data: { message: "hi" } }],
      ["support", { requestId: "support-1", message: "Please confirm." }],
    ] as const) {
      const answer = await post(await signedCall(TASKS.working, action, request));
      expect([answer.status, answer.text]).toEqual([409, '{"error":"unsupported_action"}']);
      expect(classifyLifecycleRefusal(action, answer)).toBe("ORDER_ACTION_UNSUPPORTED");
    }
    expect(lookups()).toBe(0);
    expect(db.query.mock.calls.some(([sql]) => /\b(?:INSERT|UPDATE|DELETE)\b/.test(String(sql))
      && !String(sql).includes("rate_limit_buckets"))).toBe(false);
  });

  it("names temporary failures lifecycle_unavailable and never answers 500", async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM provider_transactions")) throw new Error("connection reset");
      return { rows: [{ tokens: 1 }], rowCount: 1 };
    });
    const unavailable = await post(await readCall(TASKS.working, "status"));
    expect([unavailable.status, unavailable.text]).toEqual([503, '{"error":"lifecycle_unavailable"}']);
    expect(unavailable.contentType).toMatch(/^application\/json/);
    db.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("WHERE gateway_audience=$1 AND order_id=$2")) {
        // The stored result no longer hashes to its frozen identity.
        return { rows: [{ ...TASKS.completed, result: { ...echo, message: "Tampered." },
          observed_at: String(nowSeconds()), order_id: params[1] }] };
      }
      return { rows: [{ tokens: 1 }], rowCount: 1 };
    });
    const tampered = await post(await readCall(TASKS.completed, "artifact"));
    expect([tampered.status, tampered.text]).toEqual([503, '{"error":"lifecycle_unavailable"}']);
  });

  it("serves reads while sales are not ready and keeps bounded refusals for garbage", async () => {
    setRailStatus(false);
    expect((await post(await readCall(TASKS.working, "status"))).status).toBe(200);
    const malformed = await post({ orderId: TASKS.working.order_id });
    expect([malformed.status, json(malformed)])
      .toEqual([400, { error: "lifecycle_rejected", reason: "request_invalid" }]);
    const duplicate = await post('{"orderId":"a","orderId":"b"}');
    expect(duplicate.status).toBe(400);
    const wrongType = await signGatewayEnvelope({
      artifactType: "ProviderLifecycleGrantV1", signerKeyId: "gateway-lifecycle",
      issuedAt: nowSeconds(), validBefore: nowSeconds() + 60, payload: {},
    });
    expect((await post({ ...(await readCall(TASKS.working, "status")), grant: wrongType })).status).toBe(401);
  });
});
