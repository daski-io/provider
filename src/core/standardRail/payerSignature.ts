import {
  getAddress,
  hashTypedData,
  isErc6492Signature,
  parseSignature,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDomain,
} from "viem";
import { withRpcFailover } from "../chain/rpcFailover.js";
import type { PayerAccountType } from "../config.js";
import { logWarn } from "../logger.js";
import { RpcTransportError, type PayerRpcEndpoint } from "./payerRpc.js";

/**
 * One verifier for a payer's EIP-712 signature (port of the gateway and
 * donor contract, stricter on the ERC-1271 answer):
 *
 *   1. size: `0x` plus an even number of hex characters, 1 to 4,096 bytes;
 *   2. EOA: exactly 65 bytes with canonical low s that recovers to the payer,
 *      checked offline with no RPC;
 *   3. contract (only when PAYER_ACCOUNT_TYPES includes `contract`): an
 *      ERC-6492 counterfactual wrapper is refused; within one deadline the
 *      payer must have deployed code and answer isValidSignature(bytes32,
 *      bytes) through a read-only, gas- and byte-bounded eth_call with
 *      exactly the 32-byte word 0x1626ba7e followed by 28 zero bytes. A
 *      revert, missing code or any other answer is invalid; failure of the
 *      transport on every endpoint is a distinct, retryable outcome.
 *
 * Signatures and typed data are never logged.
 */
export const PAYER_SIGNATURE_MAX_BYTES = 4_096;
export const ERC1271_MAGIC_WORD: Hex = `0x1626ba7e${"0".repeat(56)}`;
export const PAYER_CONTRACT_VERIFY_CONCURRENCY = 8;
const SIGNATURE_SHAPE = /^0x(?:[0-9a-fA-F]{2})+$/;
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export type PayerSignatureFailure = "invalid" | "counterfactual" | "unavailable";

export class PayerSignatureError extends Error {
  constructor(readonly failure: PayerSignatureFailure) {
    super(`payer signature ${failure}`);
    this.name = "PayerSignatureError";
  }

  /** The verifier could not decide; the signature itself was not judged. */
  get retryable(): boolean {
    return this.failure === "unavailable";
  }
}

export interface PayerTypedData {
  domain: TypedDataDomain;
  types: TypedData;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PayerSignatureOptions {
  accountTypes: ReadonlySet<PayerAccountType>;
  verifyTimeoutMs: number;
  /** At most the first two are consulted: the primary and one failover. */
  endpoints: readonly PayerRpcEndpoint[];
}

let contractVerificationsInFlight = 0;

export function isPayerSignatureShape(value: unknown): value is Hex {
  return typeof value === "string" && SIGNATURE_SHAPE.test(value)
    && (value.length - 2) / 2 <= PAYER_SIGNATURE_MAX_BYTES;
}

async function recoversToPayer(payer: Address, typedData: PayerTypedData, signature: Hex): Promise<boolean> {
  if (signature.length !== 132) return false;
  try {
    const parsed = parseSignature(signature);
    if (BigInt(parsed.s) === 0n || BigInt(parsed.s) > SECP256K1_HALF_ORDER) return false;
    const recovered = await recoverTypedDataAddress({ ...typedData, signature } as never);
    return getAddress(recovered) === payer;
  } catch {
    return false;
  }
}

type ContractAnswer = { outcome: "no-code" } | { outcome: "reverted" } | { outcome: "returned"; data: Hex };

async function askContract(
  payer: Address,
  hash: Hex,
  signature: Hex,
  options: PayerSignatureOptions,
): Promise<ContractAnswer> {
  const endpoints = options.endpoints.slice(0, 2).map((endpoint) => ({ host: endpoint.host, client: endpoint }));
  if (endpoints.length === 0) throw new PayerSignatureError("unavailable");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.verifyTimeoutMs);
  deadline.unref();
  try {
    return await Promise.race([
      withRpcFailover(endpoints, async ({ client }): Promise<ContractAnswer> => {
        const code = await client.getCode(payer, controller.signal);
        if (code === "0x") return { outcome: "no-code" };
        const call = await client.isValidSignature(payer, hash, signature, controller.signal);
        return call.kind === "reverted" ? { outcome: "reverted" } : { outcome: "returned", data: call.data };
      }, {
        attempts: 1,
        baseDelayMs: 0,
        onFallback: ({ primaryHost, selectedHost }) => {
          logWarn("Payer signature RPC fallback selected", { primaryHost, selectedHost });
        },
      }),
      new Promise<never>((_, reject) => controller.signal.addEventListener(
        "abort",
        () => reject(new RpcTransportError("payer signature verification deadline exceeded")),
        { once: true },
      )),
    ]);
  } catch {
    throw new PayerSignatureError("unavailable");
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

/**
 * Verify `signature` over `typedData` for `payer`. Resolves only for a valid
 * signature; otherwise throws PayerSignatureError: `invalid` or
 * `counterfactual` are final, `unavailable` (RPC failure, deadline or
 * verification capacity) is retryable and says nothing about the signature.
 */
export async function verifyPayerTypedData(
  args: { payer: Address; typedData: PayerTypedData; signature: unknown },
  options: PayerSignatureOptions,
): Promise<{ accountType: PayerAccountType }> {
  if (!isPayerSignatureShape(args.signature)) throw new PayerSignatureError("invalid");
  const payer = getAddress(args.payer);
  const signature = args.signature.toLowerCase() as Hex;
  if (await recoversToPayer(payer, args.typedData, signature)) return { accountType: "eoa" };
  if (!options.accountTypes.has("contract")) throw new PayerSignatureError("invalid");
  if (isErc6492Signature(signature)) throw new PayerSignatureError("counterfactual");
  let hash: Hex;
  try {
    hash = hashTypedData(args.typedData as never);
  } catch {
    throw new PayerSignatureError("invalid");
  }
  if (contractVerificationsInFlight >= PAYER_CONTRACT_VERIFY_CONCURRENCY) {
    throw new PayerSignatureError("unavailable");
  }
  contractVerificationsInFlight += 1;
  let answer: ContractAnswer;
  try {
    answer = await askContract(payer, hash, signature, options);
  } finally {
    contractVerificationsInFlight -= 1;
  }
  if (answer.outcome === "returned" && answer.data.toLowerCase() === ERC1271_MAGIC_WORD) {
    return { accountType: "contract" };
  }
  throw new PayerSignatureError("invalid");
}
