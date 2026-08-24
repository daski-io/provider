import { describe, expect, it } from "vitest";
import { formatUsdc, formatUsdDecimal } from "../src/core/utils/format.js";

describe("money display formatting", () => {
  it("adds thousands separators to atomic USDC values", () => {
    expect(formatUsdc(1_234_567_890_000n)).toBe("$1,234,567.89");
    expect(formatUsdc(-1_234_567_890_000n)).toBe("-$1,234,567.89");
  });

  it("preserves small USDC values and two display decimals", () => {
    expect(formatUsdc(999_999_999n)).toBe("$999.99");
    expect(formatUsdc(1n)).toBe("$0.00");
  });

  it("adds thousands separators to gateway dollar strings", () => {
    expect(formatUsdDecimal("1234567.89")).toBe("$1,234,567.89");
    expect(formatUsdDecimal("1000")).toBe("$1,000");
  });

  it("rejects non-decimal input", () => {
    expect(() => formatUsdDecimal("1,000.00")).toThrow("invalid USD decimal");
  });
});
