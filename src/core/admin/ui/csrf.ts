import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";

const PURPOSE = "admin-ui-confirmation-v1";

export function confirmationCsrfToken(args: {
  sessionId: string;
  wallet: string;
  threadId: string;
}): string {
  return createHmac("sha256", config.ADMIN_TOKEN)
    .update(PURPOSE)
    .update("\0")
    .update(args.sessionId)
    .update("\0")
    .update(args.wallet.toLowerCase())
    .update("\0")
    .update(args.threadId)
    .digest("base64url");
}

export function validConfirmationCsrfToken(
  candidate: string,
  args: { sessionId: string; wallet: string; threadId: string },
): boolean {
  const expected = Buffer.from(confirmationCsrfToken(args));
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
