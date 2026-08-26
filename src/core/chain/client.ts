import { createPublicClient, http, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { config } from "../config.js";
import { logWarn } from "../logger.js";
import { withRpcFailover } from "./rpcFailover.js";

export const CHAIN_MODE_MOCK = config.CHAIN_MODE === "mock";
const chain = config.CHAIN_ID === 8453 ? base : baseSepolia;
const primaryUrl = CHAIN_MODE_MOCK ? "http://127.0.0.1:1" : config.BASE_RPC_URL;
const fallbackUrls = CHAIN_MODE_MOCK
  ? []
  : config.BASE_RPC_FALLBACK_URLS.split(",").map((url) => url.trim()).filter(Boolean);
const urls: [string, ...string[]] = [primaryUrl, ...fallbackUrls];

const transport: Transport = CHAIN_MODE_MOCK
  ? http(primaryUrl, { retryCount: 0, timeout: 20_000 })
  : (parameters) => {
      const endpoints = urls.map((url) => ({
        host: new URL(url).hostname,
        client: http(url, { retryCount: 0, timeout: 20_000 })(parameters),
      }));
      const primary = endpoints[0]!.client;
      const request = ((...args: Parameters<typeof primary.request>) =>
        withRpcFailover(endpoints, ({ client }) => client.request(...args), {
          onFallback: ({ primaryHost, selectedHost }) => {
            logWarn("Provider RPC fallback selected", { primaryHost, selectedHost });
          },
        })) as typeof primary.request;
      return { ...primary, request };
    };

export const publicClient: any = createPublicClient({ chain, transport });
export const providerAddress = privateKeyToAccount(
  config.PROVIDER_WALLET_PRIVATE_KEY as `0x${string}`,
).address;
