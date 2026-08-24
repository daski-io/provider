import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";

const authConfig = vi.hoisted(() => ({
  POSTMARK_INBOUND_WEBHOOK_SECRET: undefined as string | undefined,
  POSTMARK_INBOUND_WEBHOOK_SECRET_PREVIOUS: undefined as string | undefined,
}));

vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      get POSTMARK_INBOUND_WEBHOOK_SECRET() {
        return authConfig.POSTMARK_INBOUND_WEBHOOK_SECRET;
      },
      get POSTMARK_INBOUND_WEBHOOK_SECRET_PREVIOUS() {
        return authConfig.POSTMARK_INBOUND_WEBHOOK_SECRET_PREVIOUS;
      },
    },
  };
});

import { authorizePostmark } from "../src/core/email/postmarkAuth.js";

function request(args: {
  remoteAddress: string;
  localAddress: string;
  authorization?: string;
}): Request {
  return {
    socket: {
      remoteAddress: args.remoteAddress,
      localAddress: args.localAddress,
    },
    get: (name: string) =>
      name.toLowerCase() === "authorization" ? args.authorization : undefined,
  } as unknown as Request;
}

beforeEach(() => {
  authConfig.POSTMARK_INBOUND_WEBHOOK_SECRET = undefined;
  authConfig.POSTMARK_INBOUND_WEBHOOK_SECRET_PREVIOUS = undefined;
});

describe("Postmark webhook authentication", () => {
  it("rejects a public request when no webhook secret is configured", () => {
    expect(authorizePostmark(request({
      remoteAddress: "203.0.113.50",
      localAddress: "10.0.0.12",
    }))).toBe(false);
  });

  it("rejects direct and reverse-proxied loopback sockets when no secret is configured", () => {
    expect(authorizePostmark(request({
      remoteAddress: "::ffff:127.0.0.1",
      localAddress: "::ffff:127.0.0.1",
    }))).toBe(false);
    expect(authorizePostmark(request({
      remoteAddress: "127.0.0.1",
      localAddress: "127.0.0.1",
    }))).toBe(false);
  });

  it("requires a valid proof when a webhook secret is configured", () => {
    authConfig.POSTMARK_INBOUND_WEBHOOK_SECRET = "s".repeat(32);
    const authorization = `Basic ${Buffer.from(`postmark:${"s".repeat(32)}`).toString("base64")}`;
    expect(authorizePostmark(request({
      remoteAddress: "203.0.113.50",
      localAddress: "10.0.0.12",
      authorization,
    }))).toBe(true);
    expect(authorizePostmark(request({
      remoteAddress: "127.0.0.1",
      localAddress: "127.0.0.1",
    }))).toBe(false);
  });
});
