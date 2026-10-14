import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

/** Gas bound of the read-only isValidSignature call. */
export const ERC1271_CALL_GAS = 1_000_000n;
/** Byte bound of the JSON-RPC answer to the isValidSignature call. */
export const ERC1271_RESPONSE_MAX_BYTES = 16 * 1_024;
/** Byte bound of the eth_getCode answer (a deployed contract is at most 24 KiB). */
const GET_CODE_RESPONSE_MAX_BYTES = 128 * 1_024;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const erc1271Abi = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

/** The endpoint could not give an answer; never evidence about the signature. */
export class RpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTransportError";
  }
}

/**
 * One RPC endpoint the contract-account path may consult. Explicit answers
 * (no code, a revert, any returned data) are returned; transport failures
 * throw RpcTransportError so failover happens only on those.
 */
export interface PayerRpcEndpoint {
  host: string;
  getCode(address: Address, signal: AbortSignal): Promise<Hex>;
  isValidSignature(
    address: Address,
    hash: Hex,
    signature: Hex,
    signal: AbortSignal,
  ): Promise<{ kind: "returned"; data: Hex } | { kind: "reverted" }>;
}

class ResponseTooLarge extends RpcTransportError {}

/** Read a whole body under the caller's signal, refusing more than `maxBytes`. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge("RPC response exceeds its byte bound");
  }
  if (!response.body) throw new RpcTransportError("RPC response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLarge("RPC response exceeds its byte bound");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

interface JsonRpcReply {
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

async function jsonRpc(
  url: string,
  method: string,
  params: unknown[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<JsonRpcReply> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
      redirect: "error",
    });
  } catch (error) {
    throw new RpcTransportError(error instanceof Error ? error.name : "fetch failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new RpcTransportError(`RPC answered HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedBody(response, maxBytes));
  } catch (error) {
    if (error instanceof RpcTransportError) throw error;
    throw new RpcTransportError(signal.aborted ? "RPC read aborted" : "RPC response is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RpcTransportError("RPC response is malformed");
  }
  return parsed as JsonRpcReply;
}

/** EIP-1474 execution error (code 3) or a node's revert message. */
function isRevert(error: JsonRpcReply["error"]): boolean {
  if (!error) return false;
  return error.code === 3 || (typeof error.message === "string" && /revert/i.test(error.message));
}

/** A bounded JSON-RPC endpoint on an operator-configured HTTPS URL. */
export function httpPayerRpcEndpoint(url: string): PayerRpcEndpoint {
  return {
    host: new URL(url).hostname,
    async getCode(address, signal) {
      const reply = await jsonRpc(url, "eth_getCode", [address, "latest"], signal, GET_CODE_RESPONSE_MAX_BYTES);
      if (reply.error || typeof reply.result !== "string" || !HEX_DATA.test(reply.result)) {
        throw new RpcTransportError("eth_getCode did not return code");
      }
      return reply.result as Hex;
    },
    async isValidSignature(address, hash, signature, signal) {
      const data = encodeFunctionData({ abi: erc1271Abi, functionName: "isValidSignature", args: [hash, signature] });
      let reply: JsonRpcReply;
      try {
        reply = await jsonRpc(url, "eth_call", [
          { to: address, data, gas: `0x${ERC1271_CALL_GAS.toString(16)}` },
          "latest",
        ], signal, ERC1271_RESPONSE_MAX_BYTES);
      } catch (error) {
        // An oversized answer is the contract's own explicit, malformed result.
        if (error instanceof ResponseTooLarge) return { kind: "returned", data: "0x" };
        throw error;
      }
      if (reply.error) {
        if (isRevert(reply.error)) return { kind: "reverted" };
        throw new RpcTransportError("eth_call failed");
      }
      if (typeof reply.result !== "string" || !HEX_DATA.test(reply.result)) {
        return { kind: "returned", data: "0x" };
      }
      return { kind: "returned", data: reply.result as Hex };
    },
  };
}
