import type { Hex } from "viem";
import { assertNoDuplicateJsonKeys } from "./canonical.js";
import { signProviderOutcomeOffer, type UnsignedProviderOutcomeOffer } from "./offer.js";

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const privateKey = process.env.PROVIDER_WALLET_PRIVATE_KEY?.trim();
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PROVIDER_WALLET_PRIVATE_KEY must be a 32-byte private key");
  }
  const input = await stdin();
  assertNoDuplicateJsonKeys(input);
  const signed = await signProviderOutcomeOffer(
    JSON.parse(input) as UnsignedProviderOutcomeOffer,
    privateKey as Hex,
  );
  process.stdout.write(`${JSON.stringify(signed)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "offer signing failed"}\n`);
  process.exitCode = 1;
});
