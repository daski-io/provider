import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import {
  checkSupplierSpend,
  isSupplierPriceTolerance,
  parseSupplierCost,
  parseSupplierCostCeiling,
  recordedSupplierCostCeiling,
  supplierCostLimit,
  type SupplierCostCeiling,
} from "../src/core/serviceRegistry/supplierCost.js";

const ceiling = (quotedAmount: string, tolerancePercent: string, fields: Partial<SupplierCostCeiling> = {}) => ({
  kind: "supplier-cost-ceiling-v2" as const, supplier: "example", currency: "USD", quotedAmount, tolerancePercent,
  ...fields,
});
const spend = (amount: string, fields: Record<string, unknown> = {}) =>
  ({ supplier: "example", currency: "USD", amount, ...fields }) as never;
const allowed = (bound: unknown, amount: string) => checkSupplierSpend(bound as SupplierCostCeiling, spend(amount));

/** An independent reading of the rule: amount * 100 <= quoted * (100 + tolerance), at a fixed 40-digit scale. */
const fixed = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(40, "0")}`);
};
const withinRule = (amount: string, quoted: string, tolerance: string) =>
  fixed(amount) * 100n * 10n ** 40n <= fixed(quoted) * (100n * 10n ** 40n + fixed(tolerance));

describe("supplier spend limit", () => {
  it("allows up to quotedAmount * (100 + tolerancePercent) / 100, exactly", () => {
    const quoted = ceiling("4.25", "10");
    expect(supplierCostLimit(quoted)).toBe("4.675");
    for (const amount of ["0", "4.25", "4.67", "4.675", "4.67499999999999999"]) {
      expect(allowed(quoted, amount), amount).toEqual({ ok: true });
    }
    for (const amount of ["4.676", "4.675000000000000001", "5", "100"]) {
      expect(allowed(quoted, amount), amount).toEqual({ ok: false, reason: "ceiling_exceeded" });
    }
    const exact = ceiling("10", "0");
    expect(supplierCostLimit(exact)).toBe("10");
    expect(allowed(exact, "10")).toEqual({ ok: true });
    expect(allowed(exact, "10.000000000000000000")).toEqual({ ok: true });
    expect(allowed(exact, "10.000000000000000001")).toEqual({ ok: false, reason: "ceiling_exceeded" });
  });

  it("formats the limit exactly, trimming trailing zeros and never rounding", () => {
    for (const [quoted, tolerance, limit] of [
      ["12.5", "10", "13.75"], ["0", "10", "0"], ["1", "100", "2"], ["1", "100.00", "2"], ["3", "33.33", "3.9999"],
      ["0.000000000000000001", "0.01", "0.0000000000000000010001"], ["999.99", "12.34", "1123.388766"],
      [`${"9".repeat(30)}.${"9".repeat(18)}`, "99.99", "1999899999999999999999999999999.9999999999999999980001"],
    ] as const) {
      expect(supplierCostLimit(ceiling(quoted, tolerance)), `${quoted} at ${tolerance}%`).toBe(limit);
    }
  });

  it("agrees with the rule on both sides of every limit", () => {
    const unit = 10n ** 18n;
    const amount = (value: bigint) => `${value / unit}.${(value % unit).toString().padStart(18, "0")}`;
    for (const quoted of ["0", "0.01", "4.25", "10", "12.5", "999.999", "123456789.123456789"]) {
      for (const tolerance of ["0", "0.5", "1.25", "10", "33.33", "99.99", "100"]) {
        const bound = ceiling(quoted, tolerance);
        const [whole, fraction = ""] = supplierCostLimit(bound).split(".");
        // The largest 18-decimal amount at or below the limit, and its neighbours.
        const floor = BigInt(`${whole}${fraction.slice(0, 18).padEnd(18, "0")}`);
        for (const planned of [floor - 1n, floor, floor + 1n].filter((value) => value >= 0n).map(amount)) {
          expect(allowed(bound, planned).ok, `${planned} against ${quoted} at ${tolerance}%`)
            .toBe(withinRule(planned, quoted, tolerance));
        }
        expect(allowed(bound, amount(floor)).ok).toBe(true);
        expect(allowed(bound, amount(floor + 1n)).ok).toBe(false);
      }
    }
  });

  it("refuses another supplier, another currency and a malformed planned spend", () => {
    const bound = ceiling("10", "10");
    for (const planned of [
      spend("1", { supplier: "other" }), spend("1", { currency: "EUR" }), spend("-1"), spend("1e3"), spend("01"),
      spend(".5"), spend("1."), spend(`1.${"0".repeat(19)}`), spend("1", { note: "x" }), spend(1 as never),
      { supplier: "example", currency: "USD" } as never, null as never, "1" as never,
    ]) {
      expect(checkSupplierSpend(bound, planned), JSON.stringify(planned)).toEqual({ ok: false, reason: "ceiling_mismatch" });
    }
  });

  it("refuses every spend without a valid v2 ceiling, and never throws", () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("hostile"); } });
    const bounds = [
      null, undefined, {}, hostile, { ...ceiling("10", "10"), extra: true },
      { kind: "supplier-cost-ceiling-v1", supplier: "example", currency: "USD", maximumAmount: "10" },
      ceiling("10", "100.5"), ceiling("10", "101"), ceiling("10", "1.234"), ceiling("-1", "10"),
      ceiling("10", "10", { currency: "usd" }), ceiling("10", "10", { supplier: "" }),
    ];
    bounds.forEach((bound, index) => {
      expect(allowed(bound, "0"), `bound ${index}`).toEqual({ ok: false, reason: "ceiling_missing" });
    });
    expect(() => supplierCostLimit(ceiling("10", "100.5"))).toThrow("valid supplier-cost ceiling");
  });
});

describe("supplier cost and ceiling values", () => {
  it("accepts only an exact, valid reported supplier cost", () => {
    expect(parseSupplierCost({ supplier: "a:b.c_d-e", currency: "USD", amount: "12.5" }))
      .toEqual({ supplier: "a:b.c_d-e", currency: "USD", amount: "12.5" });
    expect(parseSupplierCost({ supplier: "x".repeat(64), currency: "A1B2C3D4E5F6", amount: "0" })).not.toBeNull();
    for (const value of [
      { supplier: "x".repeat(65), currency: "USD", amount: "1" }, { supplier: ".x", currency: "USD", amount: "1" },
      { supplier: "x", currency: "US", amount: "1" }, { supplier: "x", currency: "1USD", amount: "1" },
      { supplier: "x", currency: "A1B2C3D4E5F6G", amount: "1" }, { supplier: "x", currency: "USD", amount: "1".repeat(31) },
      { supplier: "x", currency: "USD", amount: 1 }, { supplier: "x", currency: "USD" },
      { supplier: "x", currency: "USD", amount: "1", extra: null }, [], "USD 1", null,
    ]) {
      expect(parseSupplierCost(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("records a reported cost as a v2 ceiling with the tolerance in force", () => {
    const recorded = recordedSupplierCostCeiling({ supplier: "example", currency: "USD", amount: "12.5" }, "2.5");
    expect(recorded).toEqual(ceiling("12.5", "2.5"));
    expect(parseSupplierCostCeiling(recorded)).toEqual(recorded);
    expect(() => recordedSupplierCostCeiling({ supplier: "example", currency: "USD", amount: "12.5" }, "100.5"))
      .toThrow("invalid");
  });

  it("knows a tolerance only as 0 to 100 with at most two decimals", () => {
    for (const value of ["0", "0.5", "10", "10.25", "99.99", "100", "100.0", "100.00"]) {
      expect(isSupplierPriceTolerance(value), value).toBe(true);
    }
    for (const value of ["100.5", "100.01", "101", "1000", "-1", "01", "1.234", "1.", ".5", " 10", "", "1e1", 10]) {
      expect(isSupplierPriceTolerance(value), String(value)).toBe(false);
    }
  });
});

describe("SUPPLIER_PRICE_TOLERANCE_PERCENT", () => {
  const environment = (tolerance?: string): NodeJS.ProcessEnv => ({
    ...process.env,
    ...(tolerance === undefined ? {} : { SUPPLIER_PRICE_TOLERANCE_PERCENT: tolerance }),
  });

  it("defaults to 10 and accepts a decimal percentage from 0 to 100", () => {
    const { SUPPLIER_PRICE_TOLERANCE_PERCENT: _unset, ...unset } = environment();
    expect(parseConfig(unset).SUPPLIER_PRICE_TOLERANCE_PERCENT).toBe("10");
    for (const value of ["0", "12.5", "100", " 7.25 "]) {
      expect(parseConfig(environment(value)).SUPPLIER_PRICE_TOLERANCE_PERCENT).toBe(value.trim());
    }
  });

  it("refuses boot, naming the variable, for anything else", () => {
    for (const value of ["100.5", "101", "-1", "1.234", "ten", ""]) {
      expect(() => parseConfig(environment(value)), value).toThrow(/SUPPLIER_PRICE_TOLERANCE_PERCENT: must be a decimal/);
    }
  });
});
