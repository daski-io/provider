import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

// CHAIN BANNER: these ops scripts are hard-wired to Base Sepolia (84532).
// Point BASE_RPC_URL elsewhere and you still get Sepolia semantics — edit
// the chain import before using against mainnet.
console.error("[chain] Base Sepolia (84532) — RPC: " + (process.env.BASE_RPC_URL ?? "https://sepolia.base.org"));

// Canonical ERC-8004 IdentityRegistry singleton on Base Sepolia.
const IDENTITY = process.env.IDENTITY_REGISTRY_ADDRESS ?? "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const RPC = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";

// agentIds from argv, falling back to PROVIDER_AGENT_ID. Ids live in the
// shared canonical registry (whatever registration minted, e.g. 8060) —
// there is no meaningful "first few ids" to scan.
const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(BigInt);
if (ids.length === 0 && process.env.PROVIDER_AGENT_ID) ids.push(BigInt(process.env.PROVIDER_AGENT_ID));
if (ids.length === 0) {
  console.error("usage: node scripts/probe-tokenuri.mjs <agentId> [agentId...]  (or set PROVIDER_AGENT_ID)");
  process.exit(1);
}

const abi = parseAbi([
  "function tokenURI(uint256) view returns (string)",
  "function ownerOf(uint256) view returns (address)",
]);

const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

for (const id of ids) {
  try {
    const [uri, owner] = await Promise.all([
      pub.readContract({ address: IDENTITY, abi, functionName: "tokenURI", args: [id] }),
      pub.readContract({ address: IDENTITY, abi, functionName: "ownerOf", args: [id] }),
    ]);
    console.log(`agentId=${id} owner=${owner}`);
    console.log(`  tokenURI=${uri}`);
  } catch (e) {
    console.log(`agentId=${id} ERROR: ${(e.shortMessage || e.message).slice(0, 100)}`);
  }
}
