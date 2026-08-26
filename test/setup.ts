process.env.NODE_ENV = "test";
process.env.PORT = "4000";
process.env.BASE_URL = "https://provider.test";
process.env.GATEWAY_BASE_URL = "https://gateway.test";
process.env.CHAIN_MODE = "live";
process.env.PROVIDER_NAME = "Test Provider";
process.env.PROVIDER_DESCRIPTION = "Provider test fixture";
process.env.PROVIDER_WEBSITE_URL = "https://provider.test/about";
process.env.PROVIDER_ICON_URL = "https://provider.test/icon.png";
process.env.MARKETPLACE_TERMS_URL = "https://marketplace.test/terms";
process.env.MARKETPLACE_PRIVACY_URL = "https://marketplace.test/privacy";
process.env.PROVIDER_TERMS_URL = "https://provider.test/terms";
process.env.PROVIDER_PRIVACY_URL = "https://provider.test/privacy";
process.env.SUPPORT_EMAIL = "support@provider.test";
process.env.DATABASE_URL =
  "postgresql://provider:test@127.0.0.1:5432/provider";
process.env.DATABASE_SSL_MODE = "disable";
process.env.CHAIN_ID = "84532";
process.env.BASE_RPC_URL = "https://rpc.test";
process.env.BASE_RPC_FALLBACK_URLS = "";
process.env.PROVIDER_WALLET_PRIVATE_KEY = `0x${"44".repeat(32)}`;
process.env.PROVIDER_AGENT_ID = "1";
process.env.IDENTITY_REGISTRY_ADDRESS =
  "0x1111111111111111111111111111111111111111";
process.env.USDC_ADDRESS = "0x6666666666666666666666666666666666666666";
process.env.RATE_LIMIT_HASH_KEY =
  "testing-only-rate-limit-key-with-entropy-1234567890";
