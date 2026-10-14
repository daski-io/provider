import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { setProviderIdentityStatus, setRailStatus } from "../src/core/health.js";
import { createApp } from "../src/core/server.js";
import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import type { ServiceResult } from "../src/core/serviceRegistry/types.js";
import { jobRuntime } from "./externalJobFixture.js";
import { FakeEvidence } from "./gatewayOrderFixture.js";
import type { ProviderAnswer } from "./gatewayWire.js";
import { claimRow, completedResult, noteService, order, wireConfig } from "./providerWireFixture.js";
import { resetWireDatabase, type WireDatabase } from "./providerWireDatabase.js";

/**
 * A lite provider configured from the fixture keys and context, served over
 * HTTP with a frozen provider clock and the in-memory database double. The
 * test file owns the `pool.js` mock and passes its database in.
 */
export interface WireHarness {
  rail: { ready: boolean };
  execute: () => Promise<ServiceResult>;
  /** Freeze the provider clock and, unless given, the database clock. */
  at(now: number, database?: number): void;
  send(http: { url: string; headers: Record<string, string>; bodyText?: string; body?: unknown }): Promise<ProviderAnswer>;
  plant(overrides?: Parameters<typeof claimRow>[0]): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startWireHarness(db: WireDatabase): Promise<WireHarness> {
  vi.useFakeTimers({ toFake: ["Date"] });
  const evidence = new FakeEvidence();
  evidence.depositTimestamps.set(order.orderId, order.payment.deposit.blockTimestamp);
  const harness = { rail: { ready: true }, execute: async () => completedResult } as WireHarness;
  const server: Server = createApp(wireConfig(), {
    dispatch: { evidence, ready: async () => harness.rail.ready },
    // A keyed runtime with a running worker, so external-job listings can be
    // quoted and admitted when a test installs one.
    externalJobs: jobRuntime(),
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(harness, {
    at(now: number, database = now) {
      vi.setSystemTime(now * 1_000);
      db.clock = database;
      setProviderIdentityStatus(true);
      setRailStatus(true);
    },
    async send(http: { url: string; headers: Record<string, string>; bodyText?: string; body?: unknown }) {
      const response = await fetch(`${origin}${new URL(http.url).pathname}`, {
        method: "POST",
        headers: http.headers,
        body: http.bodyText ?? JSON.stringify(http.body),
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentEncoding: response.headers.get("content-encoding"),
        text: await response.text(),
      };
    },
    plant(overrides: Parameters<typeof claimRow>[0] = {}) {
      db.claims.set(order.orderId, claimRow(overrides) as unknown as Record<string, unknown>);
    },
    reset() {
      resetWireDatabase(db);
      db.taskId = order.providerTaskId;
      harness.rail.ready = true;
      harness.execute = async () => completedResult;
      clearServicesForTests();
      registerService(noteService(() => harness.execute()));
    },
    close: async () => {
      vi.useRealTimers();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  });
}
