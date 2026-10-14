import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { config } from "../src/core/config.js";
import {
  concurrencyBudget,
  configureHttpTimeouts,
} from "../src/core/security/httpCapacity.js";
import { markServicingRoutes } from "../src/core/security/servicingIngress.js";

class TestResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  setHeader = vi.fn();
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

function request(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as Request;
}

describe("HTTP concurrency boundary", () => {
  it("limits one untrusted source without consuming capacity for other sources", () => {
    const budget = concurrencyBudget({
      maxConcurrent: 3,
      maxConcurrentPerIp: 2,
      bypassIps: [],
    });
    const first = new TestResponse();
    const second = new TestResponse();
    budget(request("198.51.100.1"), first as unknown as Response, vi.fn());
    budget(request("198.51.100.1"), second as unknown as Response, vi.fn());

    const rejected = new TestResponse();
    const rejectedNext = vi.fn();
    budget(request("198.51.100.1"), rejected as unknown as Response, rejectedNext);
    expect(rejected.statusCode).toBe(503);
    expect(rejectedNext).not.toHaveBeenCalled();

    const otherNext = vi.fn();
    budget(
      request("198.51.100.2"),
      new TestResponse() as unknown as Response,
      otherNext,
    );
    expect(otherNext).toHaveBeenCalledOnce();

    first.emit("finish");
    const releasedNext = vi.fn();
    budget(
      request("198.51.100.1"),
      new TestResponse() as unknown as Response,
      releasedNext,
    );
    expect(releasedNext).toHaveBeenCalledOnce();
  });

  it("lets reviewed bypass addresses use the global budget", () => {
    const budget = concurrencyBudget({
      maxConcurrent: 3,
      maxConcurrentPerIp: 1,
      bypassIps: ["10.0.0.1"],
    });
    const next = vi.fn();
    budget(request("10.0.0.1"), new TestResponse() as unknown as Response, next);
    budget(request("10.0.0.1"), new TestResponse() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("applies explicit request-receipt timeouts", () => {
    const server = { headersTimeout: 0, requestTimeout: 0, keepAliveTimeout: 0 };
    configureHttpTimeouts(server);
    expect(server).toEqual({
      headersTimeout: config.HTTP_HEADERS_TIMEOUT_MS,
      requestTimeout: config.HTTP_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: config.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    });
  });

  it("tells a busy lifecycle read the gateway's named retryable refusal", async () => {
    const app = express();
    markServicingRoutes(app);
    app.use(concurrencyBudget({ maxConcurrent: 0, maxConcurrentPerIp: 0, bypassIps: [] }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const answer = async (path: string) => {
        const response = await fetch(`${origin}${path}`, { method: "POST" });
        return [response.status, await response.text()];
      };
      expect(await answer("/standard-rail/lifecycle")).toEqual([503, '{"error":"lifecycle_unavailable"}']);
      expect(await answer("/standard-rail/dispatch")).toEqual([503, '{"error":"server_busy"}']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
