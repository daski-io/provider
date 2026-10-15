/**
 * Supplier price tolerance. A service that pays a supplier reports, at quote
 * time, the supplier's current price for the request (`supplierCost` on its
 * ready `requestReadiness` result). Core records it with the quote as the
 * order's spend ceiling, together with the tolerance in force
 * (`SUPPLIER_PRICE_TOLERANCE_PERCENT`); the ceiling never changes. Before
 * spending, the order's adapter checks the planned spend against it. Amounts
 * are decimal strings compared exactly: no floating point, no rounding.
 */

/** The supplier's current price for one request, as a service reports it. */
export interface SupplierCost {
  /** 1 to 64 of `A-Z a-z 0-9 . _ : -`, starting with a letter or digit. */
  supplier: string;
  /** An upper-case letter, then 2 to 11 upper-case letters or digits (`USD`). */
  currency: string;
  /** Non-negative decimal: no sign, exponent or leading zeros (`"12.5"`). */
  amount: string;
}

/** The spend ceiling recorded with a quote and bound to its order. */
export interface SupplierCostCeiling {
  kind: "supplier-cost-ceiling-v2";
  supplier: string;
  currency: string;
  /** The supplier price reported when the quote was issued. */
  quotedAmount: string;
  /** The tolerance in force then: a percentage from 0 to 100, at most two decimals. */
  tolerancePercent: string;
}

/** Why a planned spend is refused: no valid ceiling, another supplier or currency, or above the limit. */
export type SupplierSpendRefusal = "ceiling_missing" | "ceiling_mismatch" | "ceiling_exceeded";

/**
 * The failure code an adapter returns when it refuses a planned spend
 * (`{status: "failed", errorCode}`). It is core's own code: attested as-is
 * without being listed in the service's `failureCodes`.
 */
export const SUPPLIER_COST_CEILING_EXCEEDED = "supplier_cost_ceiling_exceeded";

const SUPPLIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CURRENCY = /^[A-Z][A-Z0-9]{2,11}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,18})?$/;
/** At most 100 with at most two decimals: `100.5` is not a tolerance. */
const TOLERANCE = /^(?:(?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?|100(?:\.00?)?)$/;
const COST_KEYS = "amount,currency,supplier";
const CEILING_KEYS = "currency,kind,quotedAmount,supplier,tolerancePercent";

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

/** An own-property copy of an object with exactly these keys; null for anything else. */
function exactly(value: unknown, keys: string): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join() !== keys) return null;
    return { ...(value as Record<string, unknown>) };
  } catch {
    return null;
  }
}

/** A reported supplier cost: exactly `{supplier, currency, amount}`, each valid; null otherwise. */
export function parseSupplierCost(value: unknown): SupplierCost | null {
  const cost = exactly(value, COST_KEYS);
  if (
    !cost || !matches(cost.supplier, SUPPLIER) || !matches(cost.currency, CURRENCY)
    || !matches(cost.amount, AMOUNT)
  ) return null;
  return { supplier: cost.supplier, currency: cost.currency, amount: cost.amount };
}

/** A v2 ceiling: exactly its five keys, each valid; null otherwise (any other kind included). */
export function parseSupplierCostCeiling(value: unknown): SupplierCostCeiling | null {
  const ceiling = exactly(value, CEILING_KEYS);
  if (
    !ceiling || ceiling.kind !== "supplier-cost-ceiling-v2"
    || !matches(ceiling.supplier, SUPPLIER) || !matches(ceiling.currency, CURRENCY)
    || !matches(ceiling.quotedAmount, AMOUNT) || !matches(ceiling.tolerancePercent, TOLERANCE)
  ) return null;
  return {
    kind: "supplier-cost-ceiling-v2",
    supplier: ceiling.supplier,
    currency: ceiling.currency,
    quotedAmount: ceiling.quotedAmount,
    tolerancePercent: ceiling.tolerancePercent,
  };
}

/** A decimal percentage from 0 to 100 with at most two decimals. */
export const isSupplierPriceTolerance = (value: unknown): value is string => matches(value, TOLERANCE);

/**
 * The ceiling core records with a quote: the supplier price the service
 * reported and the tolerance in force. Throws on an invalid cost or
 * tolerance; core validates both before it records anything.
 */
export function recordedSupplierCostCeiling(cost: SupplierCost, tolerancePercent: string): SupplierCostCeiling {
  const ceiling = parseSupplierCostCeiling({
    kind: "supplier-cost-ceiling-v2",
    supplier: cost.supplier,
    currency: cost.currency,
    quotedAmount: cost.amount,
    tolerancePercent,
  });
  if (!ceiling) throw new Error("Supplier cost or price tolerance is invalid");
  return ceiling;
}

/** An exact decimal: `digits / 10^scale`. */
const scaled = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return { digits: BigInt(`${whole}${fraction}`), scale: fraction.length };
};
const power = (scale: number) => 10n ** BigInt(scale);

/** quotedAmount * (100 + tolerancePercent) / 100, exactly, as `digits / 10^scale`. */
function limitOf(ceiling: SupplierCostCeiling): { digits: bigint; scale: number } {
  const quoted = scaled(ceiling.quotedAmount);
  const tolerance = scaled(ceiling.tolerancePercent);
  return {
    digits: quoted.digits * (100n * power(tolerance.scale) + tolerance.digits),
    scale: quoted.scale + tolerance.scale + 2,
  };
}

/**
 * Whether the order may spend `planned` at its supplier: only the ceiling's
 * supplier and currency, and only while amount * 100 <= quotedAmount *
 * (100 + tolerancePercent). No valid ceiling refuses every spend
 * (`ceiling_missing`); a malformed planned spend matches no ceiling
 * (`ceiling_mismatch`). Never throws. On a refusal the adapter spends
 * nothing and returns the failure `SUPPLIER_COST_CEILING_EXCEEDED`.
 */
export function checkSupplierSpend(
  ceiling: SupplierCostCeiling | null | undefined,
  planned: SupplierCost,
): { ok: true } | { ok: false; reason: SupplierSpendRefusal } {
  const bound = parseSupplierCostCeiling(ceiling);
  if (!bound) return { ok: false, reason: "ceiling_missing" };
  const spend = parseSupplierCost(planned);
  if (!spend || spend.supplier !== bound.supplier || spend.currency !== bound.currency) {
    return { ok: false, reason: "ceiling_mismatch" };
  }
  const amount = scaled(spend.amount);
  const limit = limitOf(bound);
  return amount.digits * power(limit.scale) <= limit.digits * power(amount.scale)
    ? { ok: true }
    : { ok: false, reason: "ceiling_exceeded" };
}

/**
 * The ceiling's limit as an exact decimal string, quotedAmount * (100 +
 * tolerancePercent) / 100 with trailing fraction zeros trimmed: for display,
 * or for a supplier API that takes a maximum price. Throws on an invalid
 * ceiling.
 */
export function supplierCostLimit(ceiling: SupplierCostCeiling): string {
  const bound = parseSupplierCostCeiling(ceiling);
  if (!bound) throw new Error("A valid supplier-cost ceiling is required");
  const { digits, scale } = limitOf(bound);
  const padded = digits.toString().padStart(scale + 1, "0");
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  const whole = padded.slice(0, -scale);
  return fraction ? `${whole}.${fraction}` : whole;
}
