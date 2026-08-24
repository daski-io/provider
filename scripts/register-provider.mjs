// One-shot script: register the provider wallet on the CANONICAL ERC-8004
// IdentityRegistry (the 0x8004A... per-chain singleton — Daski deploys no
// identity registry of its own), verify its payment wallet via
// setAgentWallet, bind it in Daski's AgentIndex, then pay the
// ProviderRegistry listing fee. Idempotent — skips steps already done.
//
// The payment-wallet step is REQUIRED: the canonical registry never
// auto-sets agentWallet at registration, and provider identity checks reject requests
// for providers without a verified agentWallet (or a per-service
// serviceWallet) with "no payee wallet".
//
// The canonical registry also has NO wallet→agentId reverse lookup; that
// lives in Daski's AgentIndex companion (resolve/claim), which is why
// AGENT_INDEX_ADDRESS is needed alongside the registry addresses.
//
// If the agent already exists but its on-chain agentURI differs from
// BASE_URL's, the script only WARNS — pass --update-uri to rewrite it.
// This keeps a locally-sourced .env (BASE_URL=http://localhost:4000) from
// clobbering the live agent's URI.
//
// Reads PROVIDER_WALLET_PRIVATE_KEY + contract addresses from env.

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, decodeEventLog, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const CHAIN_ID = Number(process.env.CHAIN_ID);
if (CHAIN_ID !== base.id && CHAIN_ID !== baseSepolia.id) {
  console.error("CHAIN_ID must be Base (8453) or Base Sepolia (84532)");
  process.exit(1);
}
const CHAIN = CHAIN_ID === base.id ? base : baseSepolia;
const DEFAULT_RPC = CHAIN_ID === base.id ? "https://mainnet.base.org" : "https://sepolia.base.org";

const PROVIDER_KEY = process.env.PROVIDER_WALLET_PRIVATE_KEY;
const IDENTITY = process.env.IDENTITY_REGISTRY_ADDRESS;
const AGENT_INDEX = process.env.AGENT_INDEX_ADDRESS;
const PROVIDER_REGISTRY = process.env.PROVIDER_REGISTRY_ADDRESS;
const USDC = process.env.USDC_ADDRESS;
const BASE_URL = process.env.BASE_URL?.trim();
const RPC = process.env.BASE_RPC_URL ?? DEFAULT_RPC;
const UPDATE_URI = process.argv.includes("--update-uri");

if (!PROVIDER_KEY || !IDENTITY || !AGENT_INDEX || !PROVIDER_REGISTRY || !USDC || !BASE_URL) {
  console.error("missing env: PROVIDER_WALLET_PRIVATE_KEY, IDENTITY_REGISTRY_ADDRESS, AGENT_INDEX_ADDRESS, PROVIDER_REGISTRY_ADDRESS, USDC_ADDRESS, BASE_URL");
  process.exit(1);
}
const providerOrigin = new URL(BASE_URL);
if (providerOrigin.protocol !== "https:" || providerOrigin.username || providerOrigin.password ||
    providerOrigin.pathname !== "/" || providerOrigin.search || providerOrigin.hash) {
  console.error("BASE_URL must be a credential-free HTTPS origin");
  process.exit(1);
}
const AGENT_URI = `${providerOrigin.origin}/.well-known/agent.json`;

console.error(`[chain] ${CHAIN.name} (${CHAIN.id}) — RPC: ${RPC}`);

const account = privateKeyToAccount(PROVIDER_KEY);
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wallet = createWalletClient({ chain: CHAIN, transport: http(RPC), account });
if (await pub.getChainId() !== CHAIN_ID) {
  console.error(`BASE_RPC_URL does not serve configured CHAIN_ID ${CHAIN_ID}`);
  process.exit(1);
}

const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function walletRotationNonce(address wallet) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
const agentIndexAbi = parseAbi([
  "function resolve(address wallet) view returns (uint256)",
  "function claim(uint256 agentId)",
]);
const provAbi = parseAbi([
  "function listingFee() view returns (uint256)",
  "function register(uint256 agentId)",
  "function isRegistered(uint256) view returns (bool)",
]);
const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
]);

// The public Base Sepolia RPC can serve stale reads (and thus stale
// gas-estimation state) right after a write — retry writes that depend on
// the previous transaction's state.
async function retryOnLag(label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 4) throw err;
      console.log(JSON.stringify({ step: "retry", label, attempt: attempt + 1 }));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function sendTx(label, params) {
  const hash = await retryOnLag(label, () => wallet.writeContract(params));
  console.log(JSON.stringify({ step: `${label}.sent`, hash }));
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(JSON.stringify({ step: `${label}.receipt`, status: receipt.status, blockNumber: receipt.blockNumber.toString() }));
  if (receipt.status !== "success") {
    console.error(`${label} reverted`);
    process.exit(2);
  }
  return receipt;
}

// EIP-5267 returns a bitmask naming which EIP-712 domain fields the
// contract's separator actually includes — echo exactly those back when
// signing, or the digest won't match (e.g. injecting a zero `salt` the
// registry doesn't hash).
function pickDomainFields({ domain, fields }) {
  const mask = Number(fields);
  return {
    ...(mask & 0x01 ? { name: domain.name } : {}),
    ...(mask & 0x02 ? { version: domain.version } : {}),
    ...(mask & 0x04 ? { chainId: domain.chainId } : {}),
    ...(mask & 0x08 ? { verifyingContract: domain.verifyingContract } : {}),
    ...(mask & 0x10 ? { salt: domain.salt } : {}),
  };
}

// Returns the provider's existing agentId (via the AgentIndex verified
// reverse lookup — the canonical registry has none) or mints a new one via
// the canonical registry's register(agentURI).
async function ensureAgent() {
  const existing = await pub.readContract({
    address: AGENT_INDEX, abi: agentIndexAbi, functionName: "resolve", args: [account.address],
  });

  if (existing !== 0n) {
    console.log(JSON.stringify({ step: "identity.skip", agentId: existing.toString(), note: "already registered" }));
    const currentURI = await pub.readContract({
      address: IDENTITY, abi: identityAbi, functionName: "tokenURI", args: [existing],
    });
    if (currentURI !== AGENT_URI) {
      if (UPDATE_URI) {
        console.log(JSON.stringify({ step: "identity.setAgentURI", from: currentURI, to: AGENT_URI }));
        await sendTx("identity.setAgentURI", {
          address: IDENTITY, abi: identityAbi, functionName: "setAgentURI", args: [existing, AGENT_URI],
        });
      } else {
        console.log(JSON.stringify({ step: "identity.uri.drift", onChain: currentURI, fromEnv: AGENT_URI, note: "left unchanged — re-run with --update-uri to rewrite" }));
      }
    }
    return existing;
  }

  console.log(JSON.stringify({ step: "identity.register", agentURI: AGENT_URI }));
  const receipt = await sendTx("identity.register", {
    address: IDENTITY, abi: identityAbi, functionName: "register", args: [AGENT_URI],
  });

  // The canonical registry has no reverse index to poll — the receipt's
  // Registered event is the authoritative source of the minted agentId.
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== IDENTITY.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: identityAbi, eventName: "Registered", data: log.data, topics: log.topics });
      console.log(JSON.stringify({ step: "identity.register.done", agentId: decoded.args.agentId.toString() }));
      return decoded.args.agentId;
    } catch {}
  }
  console.error("identity.register succeeded but emitted no Registered event");
  process.exit(3);
}

// REQUIRED: verify the provider's payment wallet on the canonical registry.
// setAgentWallet needs the NEW wallet's EIP-712 consent —
// SetAgentWallet(uint256 agentId,address newWallet,uint256 nonce,uint256
// deadline) over the registry's OWN domain, which the script reads via
// eip712Domain() (EIP-5267); nonce comes from walletRotationNonce(newWallet).
// Owner and payment wallet are the same account here, so it self-signs.
async function ensureAgentWallet(agentId) {
  const current = await pub.readContract({
    address: IDENTITY, abi: identityAbi, functionName: "getAgentWallet", args: [agentId],
  });

  if (current.toLowerCase() === account.address.toLowerCase()) {
    console.log(JSON.stringify({ step: "wallet.skip", agentWallet: current, note: "already verified" }));
    return;
  }
  if (current !== zeroAddress) {
    // A different wallet is deliberately bound (e.g. a separate payout
    // wallet). Leave it — settles pay that wallet, not the provider key.
    console.log(JSON.stringify({ step: "wallet.mismatch", agentWallet: current, note: "≠ provider wallet; leaving it — payouts go there" }));
    return;
  }

  // Without EIP-5267 there is no portable way to reconstruct the digest the
  // registry checks; the canonical 0x8004A... deployments expose it.
  let domainDescriptor;
  try {
    domainDescriptor = await pub.getEip712Domain({ address: IDENTITY });
  } catch (err) {
    console.error(
      "Could not read the canonical registry's EIP-712 domain via eip712Domain() (EIP-5267). " +
      "The SetAgentWallet consent signature must be built over that exact domain — check that " +
      "IDENTITY_REGISTRY_ADDRESS points at the canonical ERC-8004 registry (0x8004A... on " +
      `Base / Base Sepolia). Underlying: ${err}`,
    );
    process.exit(2);
  }

  const nonce = await pub.readContract({
    address: IDENTITY, abi: identityAbi, functionName: "walletRotationNonce", args: [account.address],
  });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const signature = await wallet.signTypedData({
    domain: pickDomainFields(domainDescriptor),
    types: {
      SetAgentWallet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "SetAgentWallet",
    message: { agentId, newWallet: account.address, nonce, deadline },
  });

  console.log(JSON.stringify({ step: "wallet.verify", newWallet: account.address }));
  await sendTx("wallet.setAgentWallet", {
    address: IDENTITY, abi: identityAbi, functionName: "setAgentWallet",
    args: [agentId, account.address, deadline, signature],
  });
}

// Bind the provider wallet in Daski's AgentIndex. Optional for settlement
// (payouts key off the verified agentWallet), but it keeps the provider
// resolvable through the same wallet→agentId lookup buyers use — and this
// script's own idempotence check reads it.
async function ensureIndexed(agentId) {
  const resolved = await pub.readContract({
    address: AGENT_INDEX, abi: agentIndexAbi, functionName: "resolve", args: [account.address],
  });
  if (resolved === agentId) {
    console.log(JSON.stringify({ step: "index.skip", agentId: agentId.toString(), note: "AgentIndex already binds wallet" }));
    return;
  }
  console.log(JSON.stringify({ step: "index.claim", agentId: agentId.toString() }));
  await sendTx("index.claim", {
    address: AGENT_INDEX, abi: agentIndexAbi, functionName: "claim", args: [agentId],
  });
}

async function ensureListed(agentId) {
  const isProv = await pub.readContract({
    address: PROVIDER_REGISTRY, abi: provAbi, functionName: "isRegistered", args: [agentId],
  });
  if (isProv) {
    console.log(JSON.stringify({ step: "provider.skip", note: "already registered on ProviderRegistry" }));
    return;
  }

  const fee = await pub.readContract({ address: PROVIDER_REGISTRY, abi: provAbi, functionName: "listingFee" });
  const usdcDec = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "decimals" });
  const usdcBal = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [account.address] });
  console.log(JSON.stringify({ step: "fee.check", listingFee: formatUnits(fee, usdcDec), usdcBalance: formatUnits(usdcBal, usdcDec) }));
  if (usdcBal < fee) {
    // Circle's testnet USDC has no public mint — surface the faucet rather
    // than reverting inside ProviderRegistry.register.
    console.error(`insufficient USDC for listing fee — top up at https://faucet.circle.com (Base Sepolia, USDC), wallet ${account.address}`);
    process.exit(4);
  }

  const allowance = await pub.readContract({
    address: USDC, abi: usdcAbi, functionName: "allowance", args: [account.address, PROVIDER_REGISTRY],
  });
  if (allowance < fee) {
    console.log(JSON.stringify({ step: "usdc.approve", amount: formatUnits(fee, usdcDec) }));
    await sendTx("usdc.approve", {
      address: USDC, abi: usdcAbi, functionName: "approve", args: [PROVIDER_REGISTRY, fee],
    });
  } else {
    console.log(JSON.stringify({ step: "usdc.approve.skip", note: "sufficient allowance" }));
  }

  console.log(JSON.stringify({ step: "provider.register", agentId: agentId.toString() }));
  await sendTx("provider.register", {
    address: PROVIDER_REGISTRY, abi: provAbi, functionName: "register", args: [agentId],
  });
}

console.log(JSON.stringify({ step: "start", wallet: account.address, agentURI: AGENT_URI, identity: IDENTITY, agentIndex: AGENT_INDEX, providerRegistry: PROVIDER_REGISTRY }));

const agentId = await ensureAgent();
await ensureAgentWallet(agentId);
await ensureIndexed(agentId);
await ensureListed(agentId);

// Final verify
const finalResolved = await pub.readContract({
  address: AGENT_INDEX, abi: agentIndexAbi, functionName: "resolve", args: [account.address],
});
const finalWallet = await pub.readContract({
  address: IDENTITY, abi: identityAbi, functionName: "getAgentWallet", args: [agentId],
});
const finalProv = await pub.readContract({
  address: PROVIDER_REGISTRY, abi: provAbi, functionName: "isRegistered", args: [agentId],
});
console.log(JSON.stringify({
  step: "done",
  agentId: agentId.toString(),
  agentWallet: finalWallet,
  agentWalletVerified: finalWallet.toLowerCase() === account.address.toLowerCase(),
  indexResolves: finalResolved === agentId,
  providerRegistered: finalProv,
  agentURI: AGENT_URI,
  note: "set PROVIDER_AGENT_ID to this agentId in the runtime env and redeploy",
}));
