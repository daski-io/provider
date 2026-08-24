import {
  getActiveSession,
  revokeAllSessions,
  type SessionRow,
} from "../../db/queries/sessions.js";
import { isWalletAllowed } from "../../auth/siwe.js";

/** Resolve a bearer and re-evaluate the live operator allowlist every request. */
export async function authorizeAdminUiSession(
  bearer: string,
): Promise<SessionRow | null> {
  const session = await getActiveSession(bearer);
  if (!session) return null;
  if (isWalletAllowed(session.user_label)) return session;
  await revokeAllSessions(session.user_label);
  return null;
}
