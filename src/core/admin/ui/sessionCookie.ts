export const ADMIN_SESSION_COOKIE = "daski_admin_session";
export const ADMIN_SESSION_COOKIE_PATH = "/";

export function readAdminSessionCookie(header: string): string | null {
  const target = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (!target) return null;
  try {
    return decodeURIComponent(target.slice(ADMIN_SESSION_COOKIE.length + 1));
  } catch {
    return null;
  }
}

export function clearAdminSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; Path=${ADMIN_SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0`;
}
