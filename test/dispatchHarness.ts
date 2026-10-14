import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { setProviderIdentityStatus, setRailStatus } from "../src/core/health.js";
import { createApp } from "../src/core/server.js";
import { clearServicesForTests, registerService } from "../src/core/serviceRegistry/registry.js";
import type { ServiceModule } from "../src/core/serviceRegistry/types.js";
import type { ProviderResponseSigner } from "../src/core/standardRail/dispatchResponse.js";
import { StandardQuoteService } from "../src/core/standardRail/quote.js";
import type { SyncLeaseTiming } from "../src/core/standardRail/syncLease.js";
import type { ProviderOutcomeConfig } from "../src/core/standardRail/types.js";
import { FakeEvidence } from "./gatewayOrderFixture.js";
import { gatewayStatusQuery, type ProviderAnswer } from "./gatewayWire.js";
import { echoService, railConfig, railOutcome } from "./standardRailServiceFixture.js";

type RetainedServicing = Parameters<typeof railConfig>[1];

/**
 * A provider booted over HTTP against the real pool, with only chain
 * evidence and (optionally) signing replaced. Callers point DATABASE_URL at a
 * migrated disposable database before importing this module's dependencies.
 */
export interface RailHarness {
  outcome: ProviderOutcomeConfig;
  config: ReturnType<typeof railConfig>;
  evidence: FakeEvidence;
  quotes: StandardQuoteService;
  state: { ready: boolean };
  service: ServiceModule;
  executions: number;
  origin: string;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<ProviderAnswer>;
  status(orderId: string, dispatchHash: Hex): Promise<ProviderAnswer>;
  close(): Promise<void>;
}

export async function startRailHarness(options: {
  outcome?: Partial<ProviderOutcomeConfig>;
  signer?: ProviderResponseSigner;
  service?: Partial<ServiceModule>;
  lease?: SyncLeaseTiming;
  /** Superseded versions, previous keys and audiences still serviced. */
  retained?: RetainedServicing;
} = {}): Promise<RailHarness> {
  const outcome = railOutcome(options.outcome);
  const config = railConfig([outcome], options.retained);
  const evidence = new FakeEvidence();
  const state = { ready: true };
  const harness = { executions: 0 } as RailHarness;
  const service = echoService({
    execute: async (input) => {
      harness.executions += 1;
      return {
        status: "completed",
        message: "Echo completed.",
        artifacts: [{ name: "echo_result", mimeType: "application/json", data: { message: input.message } }],
      };
    },
    ...options.service,
  });
  clearServicesForTests();
  registerService(service);
  setProviderIdentityStatus(true);
  setRailStatus(true);
  const server: Server = createApp(config, {
    dispatch: { evidence, ready: async () => state.ready, signer: options.signer, lease: options.lease },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentEncoding: response.headers.get("content-encoding"),
      text: await response.text(),
    };
  };
  return Object.assign(harness, {
    outcome,
    config,
    evidence,
    quotes: new StandardQuoteService(config, 84532),
    state,
    service,
    origin,
    post,
    status: async (orderId: string, dispatchHash: Hex) =>
      post("/standard-rail/dispatch/status", { query: await gatewayStatusQuery(orderId, dispatchHash) }),
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  });
}

export const json = (answer: ProviderAnswer) => JSON.parse(answer.text) as Record<string, unknown>;
