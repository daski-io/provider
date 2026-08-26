import type { Hex } from "viem";
import { assertNoDuplicateJsonKeys } from "./canonical.js";
import {
  signProviderOutcomeOffer,
  type UnsignedProviderOutcomeOffer,
} from "./offer.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const key = process.env.PROVIDER_WALLET_PRIVATE_KEY?.trim();
try {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("PROVIDER_WALLET_PRIVATE_KEY must be a 32-byte private key");
  }
  const input = Buffer.concat(chunks).toString("utf8");
  assertNoDuplicateJsonKeys(input);
  const signed = await signProviderOutcomeOffer(
    JSON.parse(input) as UnsignedProviderOutcomeOffer,
    key as Hex,
  );
  process.stdout.write(`${JSON.stringify(signed)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "offer signing failed"}\n`);
  process.exitCode = 1;
}
