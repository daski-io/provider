import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// CHAIN BANNER: these ops scripts are hard-wired to Base Sepolia (84532).
// Point BASE_RPC_URL elsewhere and you still get Sepolia semantics — edit
// the chain import before using against mainnet.
console.error("[chain] Base Sepolia (84532) — RPC: " + (process.env.BASE_RPC_URL ?? "https://sepolia.base.org"));

const KEY = process.env.PROVIDER_WALLET_PRIVATE_KEY;
const IDENTITY = process.env.IDENTITY_REGISTRY_ADDRESS;
const AGENT_INDEX = process.env.AGENT_INDEX_ADDRESS;
const PROVIDER_REGISTRY = process.env.PROVIDER_REGISTRY_ADDRESS;
const AGENT_ID = process.env.PROVIDER_AGENT_ID;
const RPC = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";

const account = privateKeyToAccount(KEY);
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

// The CANONICAL ERC-8004 registry has no wallet→agentId reverse lookup;
// that lives in Daski's AgentIndex companion (resolve re-checks
// ownerOf/getAgentWallet on every read, so stale bindings resolve to 0).
const abi = parseAbi([
  "function getAgentWallet(uint256) view returns (address)",
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function tokenURI(uint256) view returns (string)",
]);
const indexAbi = parseAbi([
  "function resolve(address wallet) view returns (uint256)",
]);
const provAbi = parseAbi([
  "function isRegistered(uint256) view returns (bool)",
]);

console.log("wallet:", account.address);
console.log("IDENTITY:", IDENTITY);
console.log("AGENT_INDEX:", AGENT_INDEX);
console.log("PROVIDER_REGISTRY:", PROVIDER_REGISTRY);

const bal = await pub.readContract({ address: IDENTITY, abi, functionName: "balanceOf", args: [account.address] });
console.log("identity.balanceOf(wallet):", bal.toString());

const resolved = await pub.readContract({ address: AGENT_INDEX, abi: indexAbi, functionName: "resolve", args: [account.address] });
console.log("agentIndex.resolve(wallet):", resolved.toString());
if (AGENT_ID) console.log("PROVIDER_AGENT_ID (env):", AGENT_ID);

// Probe the resolved id and the configured one — a mismatch (or resolve=0
// with a set PROVIDER_AGENT_ID) means the AgentIndex binding is missing or
// stale (run scripts/register-provider.mjs).
const ids = [...new Set([resolved, AGENT_ID ? BigInt(AGENT_ID) : 0n].filter((id) => id !== 0n))];
if (ids.length === 0) console.log("no agentId to probe (resolve=0 and PROVIDER_AGENT_ID unset)");

for (const id of ids) {
  try {
    const owner = await pub.readContract({ address: IDENTITY, abi, functionName: "ownerOf", args: [id] });
    const aw = await pub.readContract({ address: IDENTITY, abi, functionName: "getAgentWallet", args: [id] });
    const uri = await pub.readContract({ address: IDENTITY, abi, functionName: "tokenURI", args: [id] });
    console.log(`  agentId=${id}: ownerOf=${owner}, getAgentWallet=${aw}`);
    console.log(`  agentId=${id}: tokenURI=${uri}`);
  } catch (e) {
    console.log(`  agentId=${id}: not minted (${(e.shortMessage ?? e.message).slice(0, 80)})`);
  }
  try {
    const reg = await pub.readContract({ address: PROVIDER_REGISTRY, abi: provAbi, functionName: "isRegistered", args: [id] });
    console.log(`providerRegistry.isRegistered(${id}): ${reg}`);
  } catch (e) {
    console.log(`providerRegistry.isRegistered(${id}): ${e.shortMessage ?? e.message}`);
  }
}
