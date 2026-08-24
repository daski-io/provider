import { gunzipSync, gzipSync } from "node:zlib";

const PREFIX = "gzip-base64:";

export function encodeGzipBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  return `${PREFIX}${gzipSync(Buffer.from(json, "utf8")).toString("base64")}`;
}

export function decodeGzipBase64Json(value: string): string {
  if (!value.startsWith(PREFIX)) {
    throw new Error("compressed JSON prefix is missing");
  }
  const encoded = value.slice(PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("compressed JSON base64 is invalid");
  }
  return gunzipSync(Buffer.from(encoded, "base64"), {
    maxOutputLength: 1_000_000,
  }).toString("utf8");
}
