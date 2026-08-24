function normalizedBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

function parsedUrl(raw: string, label: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
}

/**
 * Accepts only the exact reviewed HTTPS origin and base path. The returned URL
 * is normalized as a directory for safe relative operation-path resolution.
 */
export function reviewedEndpoint(raw: string, reviewedBase: string): URL {
  if (/%(?:2e|2f|5c)/i.test(raw) || raw.includes("\\")) {
    throw new Error("supplier endpoint contains an encoded or ambiguous path");
  }
  const reviewed = parsedUrl(reviewedBase, "reviewed supplier endpoint");
  const candidate = parsedUrl(raw, "supplier endpoint");
  if (
    reviewed.protocol !== "https:"
    || reviewed.username
    || reviewed.password
    || reviewed.search
    || reviewed.hash
  ) {
    throw new Error("reviewed supplier endpoint policy is invalid");
  }
  if (
    candidate.protocol !== "https:"
    || candidate.hostname.toLowerCase() !== reviewed.hostname.toLowerCase()
    || candidate.port !== reviewed.port
    || candidate.username
    || candidate.password
    || candidate.search
    || candidate.hash
    || normalizedBasePath(candidate.pathname)
      !== normalizedBasePath(reviewed.pathname)
  ) {
    throw new Error("supplier endpoint does not match the reviewed endpoint");
  }

  const normalized = new URL(reviewed);
  normalized.pathname = `${normalizedBasePath(reviewed.pathname).replace(/\/$/, "")}/`;
  return normalized;
}

/** Resolves one relative operation path without allowing an origin switch. */
export function appendReviewedOperation(base: URL, operation: string): URL {
  if (
    operation.length === 0
    || operation.startsWith("/")
    || operation.startsWith("\\")
    || operation.includes("?")
    || operation.includes("#")
    || /%(?:2e|2f|5c)/i.test(operation)
  ) {
    throw new Error("supplier operation path is invalid");
  }
  const target = new URL(operation, base);
  if (
    target.origin !== base.origin
    || !target.pathname.startsWith(base.pathname)
  ) {
    throw new Error("supplier operation escaped the reviewed endpoint");
  }
  return target;
}
