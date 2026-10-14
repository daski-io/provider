import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import {
  providerResponseSigner,
  signDispatchSnapshot,
} from "../src/core/standardRail/dispatchResponse.js";
import type { ProviderTransaction } from "../src/core/standardRail/transactionStore.js";
import { acceptDispatchSnapshotAsGateway, nowSeconds } from "./gatewayWire.js";
import { railConfig } from "./standardRailServiceFixture.js";

const dispatchHash = `0x${"5e".repeat(32)}` as Hex;
const signer = providerResponseSigner(railConfig());
const result = {
  status: "completed" as const,
  message: "Echo completed.",
  artifacts: [{ name: "echo_result", mimeType: "application/json", data: { message: "hi" } }],
};

function row(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
  return {
    id: "task-1",
    gateway_audience: "https://gateway.example",
    order_id: "ord_00000000-0000-4000-8000-000000000001",
    dispatch_hash: Buffer.from(dispatchHash.slice(2), "hex"),
    payer: `0x${"11".repeat(20)}` as Hex,
    service_slug: "dummy",
    skill_id: "echo",
    state: "completed",
    result,
    created_at: new Date(),
    completed_at: new Date((nowSeconds() - 600) * 1_000),
    operations_revision: 0,
    operations_projection: { fulfillment: null, support: null, recovery: null },
    observed_at: String(nowSeconds()),
    ...overrides,
  };
}

const clone = <T>(value: T): T => structuredClone(value);

describe("signed dispatch and status snapshots", () => {
  it("answers working with exactly the five pending keys and fresh operations", async () => {
    const snapshot = await signDispatchSnapshot(
      row({ state: "executing", result: null, completed_at: null }),
      dispatchHash,
      signer,
    );
    expect(Object.keys(snapshot).sort()).toEqual(
      ["dispatchHash", "operations", "signature", "state", "taskId"],
    );
    const accepted = await acceptDispatchSnapshotAsGateway({ value: snapshot, dispatchHash });
    expect(accepted.body.state).toBe("working");
    expect(accepted.operations).toEqual({
      schemaVersion: 1, revision: 0, observedAt: nowSeconds(),
      fulfillment: null, support: null, recovery: null,
    });
  });

  it("attests completed and failed terminals without an inline result", async () => {
    for (const terminal of [
      row(),
      row({ state: "failed", result: { status: "failed", errorCode: "service_execution_failed" } }),
    ]) {
      const snapshot = await signDispatchSnapshot(terminal, dispatchHash, signer);
      expect(snapshot).not.toHaveProperty("result");
      const accepted = await acceptDispatchSnapshotAsGateway({ value: snapshot, dispatchHash });
      expect(accepted.attestation).toEqual({
        taskId: "task-1",
        dispatchHash,
        state: terminal.state,
        resultHash: canonicalHash(terminal.result),
        completedAt: Math.floor(terminal.completed_at!.getTime() / 1_000),
      });
    }
  });

  it("is invalidated by any change to state, operations, or attestation data", async () => {
    const snapshot = await signDispatchSnapshot(row(), dispatchHash, signer);
    const tampered: Array<(value: typeof snapshot) => void> = [
      (value) => { value.state = "failed"; },
      (value) => { value.operations.revision = 1; },
      (value) => { value.operations.observedAt -= 1; },
      (value) => { value.taskId = "task-2"; },
      (value) => { value.terminalAttestation!.payload.resultHash = canonicalHash({ other: true }); },
      (value) => { value.terminalAttestation!.payload.completedAt -= 1; },
      (value) => { value.terminalAttestation!.payload.state = "failed"; },
    ];
    for (const change of tampered) {
      const value = clone(snapshot);
      change(value);
      await expect(acceptDispatchSnapshotAsGateway({ value, dispatchHash })).rejects.toThrow();
    }
    const withResult = { ...clone(snapshot), result };
    await expect(acceptDispatchSnapshotAsGateway({ value: withResult, dispatchHash }))
      .rejects.toThrow("fields are invalid");
    await expect(acceptDispatchSnapshotAsGateway({
      value: snapshot, dispatchHash: `0x${"00".repeat(32)}`,
    })).rejects.toThrow();
  });

  it("fails closed instead of signing an unreviewed or stale-shaped projection", async () => {
    for (const overrides of [
      { operations_projection: { fulfillment: null, support: { reviewId: "x" }, recovery: null } },
      { operations_projection: { fulfillment: null, support: null } },
      { operations_revision: -1 },
      { observed_at: "0" },
      { result: null },
      { result: { status: "failed" as const, errorCode: "mismatch" } },
    ]) {
      await expect(signDispatchSnapshot(row(overrides), dispatchHash, signer)).rejects.toThrow();
    }
  });
});
