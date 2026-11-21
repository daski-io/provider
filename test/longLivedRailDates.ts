import { vi } from "vitest";

/*
 * Dates like those signed into a published global rail policy: issued on
 * 2026-09-25, envelopes valid before 2027-03-24, the active rail profile's
 * admission window ending 2027-03-13. The provider keeps these values as
 * signed and never enforces them, so the same policy keeps working after
 * them; only its signer, network and hashes are checked.
 */
const seconds = (iso: string): number => Date.parse(iso) / 1_000;

export const POLICY_ISSUED_AT = seconds("2026-09-25T21:28:08Z");
export const POLICY_VALID_BEFORE = seconds("2027-03-24T21:28:08Z");
export const RAIL_ADMISSION_VALID_BEFORE = seconds("2027-03-13T21:28:08Z");
export const RAIL_RECOVERY_VALID_BEFORE = seconds("2027-03-23T21:28:08Z");

/** Clocks after every one of those dates: just after, and five years on. */
export const AFTER_EXPIRY = ["2027-04-01T00:00:00Z", "2032-06-01T00:00:00Z"] as const;

/** Fake only the wall clock, so promises and timers run as usual. */
export function setClock(iso: string): number {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  return Math.floor(Date.now() / 1_000);
}

export function restoreClock(): void {
  vi.useRealTimers();
}
