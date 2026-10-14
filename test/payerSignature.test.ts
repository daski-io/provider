import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serializeErc6492Signature, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpPayerRpcEndpoint, type PayerRpcEndpoint } from "../src/core/standardRail/payerRpc.js";
import {
  ERC1271_MAGIC_WORD,
  PAYER_CONTRACT_VERIFY_CONCURRENCY,
  PayerSignatureError,
  verifyPayerTypedData,
  type PayerSignatureOptions,
  type PayerTypedData,
} from "../src/core/standardRail/payerSignature.js";

const payerKey = `0x${"5a".repeat(32)}` as Hex;
const payer = privateKeyToAccount(payerKey).address;
const contractAccount = "0x0000000000000000000000000000000000c0ffee" as Address;
const typedData: PayerTypedData = {
  domain: { name: "DaskiStandardOrder", version: "1", chainId: 84532 },
  types: { Probe: [{ name: "value", type: "uint256" }] },
  primaryType: "Probe",
  message: { value: 7n },
};
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const sign = (key: Hex = payerKey) => privateKeyToAccount(key).signTypedData(typedData as never);

/** The same signature with s replaced by n - s and v flipped: valid ECDSA, not canonical. */
function highS(signature: Hex): Hex {
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130) === "1b" ? "1c" : "1b";
  return `${signature.slice(0, 66)}${(SECP256K1_ORDER - s).toString(16).padStart(64, "0")}${v}` as Hex;
}

function endpoint(answer: Partial<{
  code: Hex;
  call: { kind: "returned"; data: Hex } | { kind: "reverted" };
  fail: boolean;
  hang: boolean;
}> = {}) {
  const value: PayerRpcEndpoint & { calls: number } = {
    host: "rpc.example",
    calls: 0,
    async getCode(_address, signal) {
      value.calls += 1;
      if (answer.hang) {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (answer.fail) throw new Error("ECONNREFUSED");
      return answer.code ?? "0x6080";
    },
    async isValidSignature() {
      return answer.call ?? { kind: "returned", data: ERC1271_MAGIC_WORD };
    },
  };
  return value;
}

const options = (endpoints: PayerRpcEndpoint[], contract = true): PayerSignatureOptions => ({
  accountTypes: new Set(contract ? ["eoa", "contract"] : ["eoa"]),
  verifyTimeoutMs: 500,
  endpoints,
});

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PayerSignatureError) return error.failure;
    throw error;
  }
  return "verified";
};

describe("payer signature verification", () => {
  it("verifies an EOA offline and refuses malformed, non-canonical or foreign signatures", async () => {
    const rpc = endpoint();
    await expect(verifyPayerTypedData({ payer, typedData, signature: await sign() }, options([rpc])))
      .resolves.toEqual({ accountType: "eoa" });
    expect(rpc.calls).toBe(0);
    for (const signature of [
      highS(await sign()),
      await sign(`0x${"5b".repeat(32)}` as Hex),
      "0x1234",
      "0x123",
      `0x${"ab".repeat(4_097)}`,
      42,
      null,
    ]) {
      expect(await failure(verifyPayerTypedData({ payer, typedData, signature }, options([rpc], false))))
        .toBe("invalid");
    }
    expect(rpc.calls).toBe(0);
  });

  it("admits a deployed ERC-1271 account only with the exact padded magic word", async () => {
    const signature = await sign(`0x${"5c".repeat(32)}` as Hex);
    const verify = (rpc: PayerRpcEndpoint, contract = true) =>
      failure(verifyPayerTypedData({ payer: contractAccount, typedData, signature }, options([rpc], contract)));
    expect(await verify(endpoint())).toBe("verified");
    expect(await verify(endpoint(), false)).toBe("invalid");
    for (const data of [
      `0x1626ba7e${"0".repeat(55)}1`,
      "0x1626ba7e",
      `0x1626ba7e${"0".repeat(64)}`,
      `0xffffffff${"0".repeat(56)}`,
      "0x",
    ] as Hex[]) {
      expect(await verify(endpoint({ call: { kind: "returned", data } })), data).toBe("invalid");
    }
    expect(await verify(endpoint({ call: { kind: "reverted" } }))).toBe("invalid");
    expect(await verify(endpoint({ code: "0x" }))).toBe("invalid");
  });

  it("refuses counterfactual ERC-6492 wrappers without consulting the chain", async () => {
    const rpc = endpoint();
    const wrapped = serializeErc6492Signature({
      address: "0x0000000000000000000000000000000000000fac",
      data: "0xdeadbeef",
      signature: await sign(),
    });
    expect(await failure(verifyPayerTypedData(
      { payer: contractAccount, typedData, signature: wrapped }, options([rpc]),
    ))).toBe("counterfactual");
    expect(rpc.calls).toBe(0);
  });

  it("reports transport failure, deadlines and saturation as retryable, never as invalid", async () => {
    const signature = await sign(`0x${"5c".repeat(32)}` as Hex);
    const verify = (endpoints: PayerRpcEndpoint[]) =>
      failure(verifyPayerTypedData({ payer: contractAccount, typedData, signature }, options(endpoints)));
    expect(await verify([endpoint({ fail: true }), endpoint({ fail: true })])).toBe("unavailable");
    expect(await verify([])).toBe("unavailable");
    const fallback = endpoint();
    expect(await verify([endpoint({ fail: true }), fallback])).toBe("verified");
    expect(fallback.calls).toBe(1);
    const started = Date.now();
    expect(await verify([endpoint({ hang: true })])).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
    const hanging = Array.from({ length: PAYER_CONTRACT_VERIFY_CONCURRENCY }, () => verify([endpoint({ hang: true })]));
    expect(await verify([endpoint()])).toBe("unavailable");
    expect(await Promise.all(hanging)).toEqual(hanging.map(() => "unavailable"));
    expect(new PayerSignatureError("unavailable").retryable).toBe(true);
    expect(new PayerSignatureError("invalid").retryable).toBe(false);
  });
});

describe("bounded JSON-RPC endpoint", () => {
  let server: Server;
  let url: string;
  const requests: Array<{ method: string; params: unknown[] }> = [];
  let reply: (method: string) => { status?: number; body: string } = () => ({ body: "{}" });

  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; params: unknown[] };
  };

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const call = await body(request);
      requests.push(call);
      const answer = reply(call.method);
      response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      response.end(answer.body);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const rpcResult = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

  it("reads code and calls isValidSignature read-only with a gas bound", async () => {
    const rpc = httpPayerRpcEndpoint(url);
    reply = (method) => ({ body: rpcResult(method === "eth_getCode" ? "0x6080" : ERC1271_MAGIC_WORD) });
    const signal = new AbortController().signal;
    await expect(rpc.getCode(contractAccount, signal)).resolves.toBe("0x6080");
    await expect(rpc.isValidSignature(contractAccount, `0x${"11".repeat(32)}`, "0x1234", signal))
      .resolves.toEqual({ kind: "returned", data: ERC1271_MAGIC_WORD });
    expect(requests.at(-1)).toMatchObject({
      method: "eth_call",
      params: [{ to: contractAccount, gas: "0xf4240" }, "latest"],
    });
  });

  it("separates explicit answers from transport failures", async () => {
    const rpc = httpPayerRpcEndpoint(url);
    const signal = new AbortController().signal;
    const call = () => rpc.isValidSignature(contractAccount, `0x${"11".repeat(32)}`, "0x1234", signal);
    reply = () => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }) });
    await expect(call()).resolves.toEqual({ kind: "reverted" });
    reply = () => ({ body: rpcResult(`0x${"00".repeat(20_000)}`) });
    await expect(call()).resolves.toEqual({ kind: "returned", data: "0x" });
    reply = () => ({ body: rpcResult(17) });
    await expect(call()).resolves.toEqual({ kind: "returned", data: "0x" });
    for (const answer of [
      { status: 502, body: "{}" },
      { body: "<html>edge</html>" },
      { body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } }) },
    ]) {
      reply = () => answer;
      await expect(call()).rejects.toThrow();
    }
    reply = () => ({ body: rpcResult(null) });
    await expect(rpc.getCode(contractAccount, signal)).rejects.toThrow("eth_getCode did not return code");
  });
});
