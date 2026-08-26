import { z } from "zod";
import { isAddress } from "viem";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_EXTERNAL_CONTRACTS,
} from "./chain/reviewedDeployments.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export const strictBooleanEnv = z.preprocess((value) => {
  if (typeof value === "boolean" || value === undefined) return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return value;
}, z.boolean());

const address = z.string().refine(isAddress, "must be a valid EVM address");
const httpsUrl = z.string().trim().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "must be a credential-free HTTPS URL");
const uint256 = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value.trim())
    ? BigInt(value.trim())
    : value,
  z.bigint().min(0n).max((1n << 256n) - 1n),
);

function isLoopbackUrl(value: string): boolean {
  const host = new URL(value).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function hasOverbroadCidr(value: string): boolean {
  return value.split(",").map((part) => part.trim()).filter(Boolean).some((entry) => {
    const slash = entry.lastIndexOf("/");
    if (slash < 0) return false;
    const prefix = Number(entry.slice(slash + 1));
    if (!Number.isInteger(prefix)) return true;
    return entry.slice(0, slash).includes(":") ? prefix < 64 : prefix < 24;
  });
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DEPLOYMENT_REVISION: z.string().trim().min(1).max(128).optional(),
  BASE_URL: z.string().url(),
  GATEWAY_BASE_URL: httpsUrl,
  CHAIN_MODE: z.enum(["live", "mock"]).default("live"),

  PROVIDER_NAME: z.string().trim().min(1),
  PROVIDER_DESCRIPTION: z.string().trim().max(2_000).optional(),
  PROVIDER_WEBSITE_URL: httpsUrl.optional(),
  PROVIDER_ICON_URL: httpsUrl.optional(),
  MARKETPLACE_TERMS_URL: httpsUrl,
  MARKETPLACE_PRIVACY_URL: httpsUrl,
  PROVIDER_TERMS_URL: httpsUrl,
  PROVIDER_PRIVACY_URL: httpsUrl,
  SUPPORT_EMAIL: z.string().email(),
  SUPPORT_RESPONSE_SLA: z.string().trim().min(1).max(200).default("1 business day"),

  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_CA_CERT: z.string().optional(),
  DATABASE_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  DATABASE_IDLE_TX_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_APPLICATION_NAME: z.string().min(1).max(63).default("daski-provider"),

  CHAIN_ID: z.coerce.number().int().refine(
    (value) => value === 8453 || value === 84532,
    "CHAIN_ID must be Base (8453) or Base Sepolia (84532)",
  ),
  BASE_RPC_URL: httpsUrl,
  BASE_RPC_FALLBACK_URLS: z.string().default("").refine((csv) =>
    csv.split(",").map((value) => value.trim()).filter(Boolean).every((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }), "must contain only credential-free HTTPS URLs"),
  PROVIDER_WALLET_PRIVATE_KEY: z.string().regex(
    /^0x[0-9a-fA-F]{64}$/,
    "must be 0x followed by exactly 64 hexadecimal characters",
  ).refine((value) => !/^0x0+$/.test(value), "must not be the zero key"),
  PROVIDER_AGENT_ID: uint256,
  IDENTITY_REGISTRY_ADDRESS: address,
  USDC_ADDRESS: address,

  RATE_LIMIT_HASH_KEY: z.string().min(32).refine(
    (value) => new Set(value).size >= 8 && !/replace/i.test(value),
    "must be a high-entropy secret, not a placeholder",
  ),
  RATE_LIMIT_GLOBAL_CAPACITY: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().positive().default(300),
  RATE_LIMIT_RAIL_CAPACITY: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_RAIL_PER_MIN: z.coerce.number().positive().default(120),
  RATE_LIMIT_HEALTH_CAPACITY: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_BYPASS_IPS: z.string().default(""),
  EDGE_RATE_LIMIT_VERIFIED: strictBooleanEnv.default(false),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  TRUST_PROXY_CIDRS: z.string().default(""),
  HTTP_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(10_000).default(200),
  HTTP_MAX_CONCURRENCY_PER_IP: z.coerce.number().int().min(1).max(1_000).default(20),
  HTTP_HEADERS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  HTTP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  HEALTH_READINESS_CACHE_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  READINESS_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(3_600).default(180),

  OUTBOUND_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  OUTBOUND_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(100_000_000).default(5_000_000),
  OUTBOUND_MAX_CONCURRENCY_PER_ORIGIN: z.coerce.number().int().min(1).max(1_000).default(16),
  OUTBOUND_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  OUTBOUND_CIRCUIT_OPEN_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
}).superRefine((env, ctx) => {
  const production = env.NODE_ENV === "production";
  const mainnet = env.CHAIN_ID === BASE_MAINNET_CHAIN_ID;
  const reject = (path: keyof typeof env, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  if ((production || mainnet) && env.CHAIN_MODE === "mock") {
    reject("CHAIN_MODE", "mock mode is forbidden in production and on Base mainnet");
  }
  if (env.CHAIN_MODE === "mock" && !isLoopbackUrl(env.BASE_URL)) {
    reject("BASE_URL", "mock mode requires a loopback BASE_URL");
  }
  if (mainnet && !production) {
    reject("NODE_ENV", "Base mainnet requires NODE_ENV=production");
  }
  if (production && new URL(env.BASE_URL).protocol !== "https:") {
    reject("BASE_URL", "production BASE_URL must use HTTPS");
  }
  if (production && env.DATABASE_SSL_MODE !== "verify-full") {
    reject("DATABASE_SSL_MODE", "production requires DATABASE_SSL_MODE=verify-full");
  }
  if (production && (!env.MIGRATION_DATABASE_URL || env.MIGRATION_DATABASE_URL === env.DATABASE_URL)) {
    reject("MIGRATION_DATABASE_URL", "production requires a distinct migration database principal");
  }
  if (env.HTTP_MAX_CONCURRENCY_PER_IP > env.HTTP_MAX_CONCURRENCY) {
    reject("HTTP_MAX_CONCURRENCY_PER_IP", "cannot exceed HTTP_MAX_CONCURRENCY");
  }
  if (env.HTTP_HEADERS_TIMEOUT_MS > env.HTTP_REQUEST_TIMEOUT_MS) {
    reject("HTTP_HEADERS_TIMEOUT_MS", "cannot exceed HTTP_REQUEST_TIMEOUT_MS");
  }
  if (production && hasOverbroadCidr(env.TRUST_PROXY_CIDRS)) {
    reject("TRUST_PROXY_CIDRS", "production proxy ranges must be IPv4 /24 or IPv6 /64, or narrower");
  }
  if (production && hasOverbroadCidr(env.RATE_LIMIT_BYPASS_IPS)) {
    reject("RATE_LIMIT_BYPASS_IPS", "production bypass ranges must be explicit or narrowly scoped");
  }
  if (mainnet && (env.TRUST_PROXY_HOPS < 1 || !env.TRUST_PROXY_CIDRS.trim())) {
    reject("TRUST_PROXY_CIDRS", "Base mainnet requires a reviewed reverse-proxy topology");
  }
  if (mainnet && !env.EDGE_RATE_LIMIT_VERIFIED) {
    reject("EDGE_RATE_LIMIT_VERIFIED", "Base mainnet requires verified edge rate limiting");
  }
  if (
    mainnet
    && env.IDENTITY_REGISTRY_ADDRESS.toLowerCase()
      !== BASE_MAINNET_EXTERNAL_CONTRACTS.identityRegistry.toLowerCase()
  ) {
    reject("IDENTITY_REGISTRY_ADDRESS", "Base mainnet requires the canonical IdentityRegistry");
  }
  if (
    mainnet
    && env.USDC_ADDRESS.toLowerCase() !== BASE_MAINNET_EXTERNAL_CONTRACTS.usdc.toLowerCase()
  ) {
    reject("USDC_ADDRESS", "Base mainnet requires canonical Circle USDC");
  }
});

export type Config = z.infer<typeof envSchema>;

export class ConfigurationError extends Error {
  constructor(issues: string[]) {
    super("Invalid configuration:\n" + issues.map((issue) => `- ${issue}`).join("\n"));
    this.name = "ConfigurationError";
  }
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  if (env.PAYMENT_RAIL !== undefined) {
    throw new ConfigurationError([
      "PAYMENT_RAIL is retired; the provider always uses standard Exact-EVM",
    ]);
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError([...new Set(parsed.error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "environment";
      return `${path}: ${issue.message}`;
    }))]);
  }
  return parsed.data;
}

export const config: Config = parseConfig(process.env);
