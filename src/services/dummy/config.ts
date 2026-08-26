export const DUMMY_SLUG = "dummy";
export const DUMMY_SKILL_ID = "echo";
export const DUMMY_PRICE_ATOMIC = "10000";
export const DUMMY_OUTCOME_ID = "dummy.echo.v1";

export function assertDummyServiceAllowed(chainId: number): void {
  if (chainId === 8453) {
    throw new Error("The dummy service must be replaced before Base mainnet deployment");
  }
}
