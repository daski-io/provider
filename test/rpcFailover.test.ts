import { describe, expect, it, vi } from "vitest";
import { withRpcFailover } from "../src/core/chain/rpcFailover.js";

const endpoints = [
  { host: "primary.example", client: "primary" },
  { host: "fallback.example", client: "fallback" },
] as const;

describe("withRpcFailover", () => {
  it("does not contact a fallback when the primary succeeds", async () => {
    const observe = vi.fn(async ({ client }: (typeof endpoints)[number]) => client);

    await expect(withRpcFailover(endpoints, observe, { baseDelayMs: 0 }))
      .resolves.toBe("primary");
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(endpoints[0]);
  });

  it("exhausts primary retries before selecting a fallback", async () => {
    const selected: string[] = [];
    const onFallback = vi.fn();
    const result = await withRpcFailover(endpoints, async ({ client }) => {
      selected.push(client);
      if (client === "primary") throw new Error("primary unavailable");
      return client;
    }, { attempts: 3, baseDelayMs: 0, onFallback });

    expect(result).toBe("fallback");
    expect(selected).toEqual(["primary", "primary", "primary", "fallback"]);
    expect(onFallback).toHaveBeenCalledWith({
      primaryHost: "primary.example",
      selectedHost: "fallback.example",
    });
  });

  it("fails closed after every endpoint exhausts its retries", async () => {
    const promise = withRpcFailover(endpoints, async ({ host }) => {
      throw new Error(host + " unavailable");
    }, { attempts: 1, baseDelayMs: 0 });

    await expect(promise).rejects.toMatchObject({
      name: "AggregateError",
      message: "RPC observation failed on the primary and every configured fallback",
      errors: [{}, {}],
    });
  });
});
