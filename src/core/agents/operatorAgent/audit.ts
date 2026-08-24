/** Remove confirmation bearers before tool arguments/results enter audit events. */
export function redactConfirmationTokens(json: string): string {
  return json.replace(
    /("confirmation_token"\s*:\s*")[^"]+(")/g,
    "$1<redacted>$2",
  );
}
