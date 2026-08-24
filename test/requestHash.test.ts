import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  computeRequestHash,
} from "../src/core/auth/requestHash.js";

describe("bounded canonical request hashing", () => {
  it("normalizes plain objects while preserving array order", () => {
    expect(
      canonicalJsonStringify({
        z: [true, null, "value"],
        a: Object.assign(Object.create(null), { b: 2, a: 1 }),
      }),
    ).toBe('{"a":{"a":1,"b":2},"z":[true,null,"value"]}');
    expect(computeRequestHash(null as never)).toBe(computeRequestHash({}));
  });

  it("rejects non-JSON scalar and object values", () => {
    expect(() => canonicalJsonStringify(1n)).toThrow(/non-JSON/);
    expect(() => canonicalJsonStringify(new Date())).toThrow(/plain objects/);
    expect(() => canonicalJsonStringify({ value: Infinity })).toThrow(/finite/);
  });

  it("rejects cycles and sparse arrays", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow(/cycles/);
    const sparse = new Array(2);
    sparse[1] = "present";
    expect(() => canonicalJsonStringify(sparse)).toThrow(/sparse arrays/);
  });

  it("rejects prototype-sensitive and undefined fields", () => {
    expect(() =>
      canonicalJsonStringify({ ["constructor"]: "value" }),
    ).toThrow(/forbidden key/);
    expect(() => canonicalJsonStringify({ value: undefined })).toThrow(
      /undefined/,
    );
  });

  it("enforces depth, node-count, and encoded-byte limits", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 66; index++) nested = { nested };
    expect(() => canonicalJsonStringify(nested)).toThrow(/depth limit/);
    expect(() => canonicalJsonStringify(new Array(50_001).fill(null))).toThrow(
      /node limit/,
    );
    expect(() => canonicalJsonStringify("x".repeat(1_000_001))).toThrow(
      /size limit/,
    );
  });
});
