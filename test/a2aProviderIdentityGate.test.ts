import express from "express";
import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({ authorized: false }));

vi.mock("../src/core/chain/providerIdentity.js", () => ({
  getProviderIdentityAuthorization: vi.fn(() => ({
    ok: state.authorized,
    checkedAt: new Date(),
    reason: state.authorized ? null : "provider identity is not verified",
  })),
}));
vi.mock("../src/core/a2a/handlers/tasksGet.js", () => ({
  handleTasksGet: vi.fn(async (
    _params: unknown,
    _slug: string,
    res: express.Response,
    id: string,
  ) => res.json({ jsonrpc: "2.0", id, result: { routed: true } })),
}));
vi.mock("../src/core/a2a/handlers/tasksCancel.js", () => ({
  handleTasksCancel: vi.fn(),
}));
vi.mock("../src/core/a2a/handlers/paidSkill/index.js", () => ({
  handlePaidSkill: vi.fn(),
}));
vi.mock("../src/core/a2a/handlers/freeSkill.js", () => ({
  handleFreeSkill: vi.fn(),
}));
vi.mock("../src/core/a2a/handlers/taskInput.js", () => ({
  handleTaskInput: vi.fn(),
}));
vi.mock("../src/core/a2a/handlers/pushNotificationSet.js", () => ({
  handlePushNotificationSet: vi.fn(),
}));
vi.mock("../src/core/a2a/handlers/pushNotificationGet.js", () => ({
  handlePushNotificationGet: vi.fn(),
}));
vi.mock("../src/core/logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../src/core/events/emitter.js", () => ({
  emitEvent: vi.fn(async () => undefined),
}));

import { a2aRouter } from "../src/core/a2a/router.js";
import { DASKI_ERR, JSON_RPC } from "../src/core/a2a/jsonrpc.js";
import { handleTasksGet } from "../src/core/a2a/handlers/tasksGet.js";

let server: Server;
let endpoint: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/a2a", a2aRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  endpoint = `http://127.0.0.1:${address.port}/a2a/dummy`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  state.authorized = false;
  vi.mocked(handleTasksGet).mockClear();
});

async function post(body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<Record<string, any>>;
}

describe("A2A provider identity gate", () => {
  it("rejects valid A2A traffic before any handler when identity is revoked", async () => {
    const body = await post({
      jsonrpc: "2.0",
      id: "request-1",
      method: "GetTask",
      params: { id: "task-1" },
    });
    expect(body.error).toMatchObject({
      code: DASKI_ERR.PROVIDER_IDENTITY_UNAVAILABLE,
      data: { recoverable: true },
    });
    expect(handleTasksGet).not.toHaveBeenCalled();
  });

  it("preserves JSON-RPC validation before the identity gate", async () => {
    const body = await post({ id: "request-2", method: "GetTask" });
    expect(body.error.code).toBe(JSON_RPC.INVALID_REQUEST);
  });

  it("routes normally while the provider identity is fresh", async () => {
    state.authorized = true;
    const body = await post({
      jsonrpc: "2.0",
      id: "request-3",
      method: "GetTask",
      params: { id: "task-1" },
    });
    expect(body.result).toEqual({ routed: true });
    expect(handleTasksGet).toHaveBeenCalledOnce();
  });
});
