const SENSITIVE_KEY = /(?:^|_)(?:ssn|social_security|dob|date_of_birth|birth_date|password|secret|api_key|private_key|auth_code|authorization|cookie|signed_tx|serialized_transaction|raw_transaction|request_body|rpc_request|email|phone|address|street|postal|zip|to|from|recipient|sender|subject|first_name|middle_name|last_name|full_name|legal_name|responsible_party_name)(?:$|_)/i;
const PERSON_CONTAINER = /(?:contact|person|party|official|member|manager|director|president|secretary|treasurer|partner|organizer|filer)/i;

export function redactSensitiveValue(
  value: unknown,
  key = "",
  depth = 0,
  parentKey = "",
): unknown {
  if (depth > 20) return "<redacted:depth-limit>";
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const normalizedParent = parentKey.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (SENSITIVE_KEY.test(normalizedKey)
    || (normalizedKey === "name" && PERSON_CONTAINER.test(normalizedParent))) {
    if (typeof value === "string" && value.startsWith("daski:v1:")) return value;
    return `<redacted:${key || "sensitive"}>`;
  }
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map((item) => redactSensitiveValue(item, key, depth + 1, parentKey));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
      out[childKey] = redactSensitiveValue(childValue, childKey, depth + 1, key);
    }
    return out;
  }
  return value;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, (match) =>
      `${match.slice(0, match.indexOf(" "))} <redacted:authorization>`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted:jwt>")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}/<redacted:url>`;
      } catch {
        return "<redacted:url>";
      }
    })
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1=<redacted:secret>",
    )
    .replace(
      /\b((?:serialized|signed|raw)[ _-]?(?:transaction|tx)|request[ _-]?body)\s*[:=]\s*(?:"[^"]*"|'[^']*'|0x[0-9a-fA-F]+|[^\s,;&]+)/gi,
      "$1=<redacted:payload>",
    )
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "<redacted:ssn>")
    .replace(/\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, "<redacted:date>")
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/](?:19|20)?\d{2}\b/g, "<redacted:date>")
    .replace(/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b\.?/gi, "<redacted:address>")
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, "<redacted:phone>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted:email>")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "<redacted:secret>");
}
