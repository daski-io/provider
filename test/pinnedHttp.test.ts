import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { pinnedHttpRequest } from "../src/core/security/pinnedHttp.js";

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve());
  });
  server = null;
});

describe("pinnedHttpRequest", () => {
  it("connects to the validated IP while preserving the original Host header", async () => {
    let receivedHost = "";
    server = http.createServer((request, response) => {
      receivedHost = request.headers.host ?? "";
      response.setHeader("content-type", "application/json");
      response.end("{\"ok\":true}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");

    const response = await pinnedHttpRequest({
      url: new URL(`http://unresolvable.invalid:${address.port}/profile`),
      pinnedIp: "127.0.0.1",
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });

    expect(response.status).toBe(200);
    expect(response.body.toString("utf8")).toBe("{\"ok\":true}");
    expect(receivedHost).toBe(`unresolvable.invalid:${address.port}`);
  });
});
