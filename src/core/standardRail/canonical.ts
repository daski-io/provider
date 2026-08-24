import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";

function assertValidUnicode(input: string): void {
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Canonical JSON contains invalid Unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Canonical JSON contains invalid Unicode");
    }
  }
}

function value(input: unknown): string {
  if (input === null) return "null";
  if (typeof input === "string") {
    assertValidUnicode(input);
    return JSON.stringify(input);
  }
  if (typeof input === "boolean") return JSON.stringify(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("Noncanonical number");
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map(value).join(",")}]`;
  if (!input || typeof input !== "object") throw new Error("Unsupported canonical value");
  const object = input as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => {
    assertValidUnicode(key);
    if (object[key] === undefined) throw new Error("Undefined canonical value");
    return `${JSON.stringify(key)}:${value(object[key])}`;
  }).join(",")}}`;
}

export const canonicalJson = (input: unknown): string => value(input);
export const canonicalHash = (input: unknown): Hex => keccak256(stringToHex(value(input)));

export function recipeNonce(input: {
  chainId: number;
  canonicalToken: Address;
  payer: Address;
  splitter: Address;
  grossAmount: bigint;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
}): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "address" },
      { type: "address" }, { type: "address" }, { type: "uint256" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" },
    ],
    [
      keccak256(stringToHex("DaskiStandardExactOrderV1")), BigInt(input.chainId),
      input.canonicalToken, input.payer, input.splitter, input.grossAmount,
      input.listingManifestHash, input.providerOfferHash, input.quoteHash,
      input.canonicalRequestHash, input.orderNonce,
    ],
  ));
}

export function assertExactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

export const SIGNED_ENVELOPE_KEYS = [
  "artifactType", "schemaVersion", "environment", "chainId", "audience", "signerKeyId",
  "issuedAt", "validBefore", "payload", "signature",
] as const;

export function assertNoDuplicateJsonKeys(text: string): void {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "")) offset += 1; };
  const stringToken = (): string => {
    const start = offset;
    if (text[offset] !== '"') throw new Error("JSON string expected");
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") { offset += 2; continue; }
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new Error("Unterminated JSON string");
  };
  const parseValue = (): void => {
    whitespace();
    if (text[offset] === '"') { stringToken(); return; }
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") { offset += 1; return; }
      while (true) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new Error(`Duplicate JSON key ${key}`);
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error("JSON colon expected");
        offset += 1;
        parseValue();
        whitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("JSON comma expected");
        offset += 1;
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      while (true) {
        parseValue();
        whitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("JSON comma expected");
        offset += 1;
      }
    }
    const token = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error("Invalid JSON token");
    offset += token.length;
  };
  parseValue();
  whitespace();
  if (offset !== text.length) throw new Error("Trailing JSON content");
}

export function unsignedEnvelopeHash(envelope: Record<string, unknown>): Hex {
  const { signature: _signature, ...unsigned } = envelope;
  return canonicalHash(unsigned);
}
