const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|skip|drop)\b[^\n]*?\b(?:above|previous|prior|preceding|earlier|foregoing|all|any|the)\b[^\n]*?\b(?:instruction|message|prompt|context|direction|rule|guideline|guardrail)s?\b[^\n]*/gi,
  /\b(?:ignore|disregard|forget)\s+(?:the\s+|all\s+|everything\s+)?(?:above|below|previous|prior|preceding|earlier|foregoing)\b[^\n]*/gi,
  /\byou\s+are\s+now\b[^\n]*/gi,
  /\bfrom\s+now\s+on\b[^\n]*/gi,
  /\b(?:act|behave|respond|talk|speak|roleplay|role-play)\s+as\s+(?:if\s+)?(?:an?|the)?\b[^\n]*/gi,
  /\bpretend\s+(?:to\s+be|that|you(?:'re|\s+are))\b[^\n]*/gi,
  /\b(?:reveal|show|print|repeat|output|expose|display|reprint|tell\s+me|give\s+me|share|leak)\b[^\n]*?\b(?:system\s+)?(?:prompt|instruction)s?\b[^\n]*/gi,
  /\b(?:override|bypass|disable|circumvent|turn\s+off|ignore|disregard|forget|violate)\b[^\n]*?\b(?:instruction|rule|guideline|guardrail|restriction|bound|filter|polic|constraint|limitation)\w*[^\n]*/gi,
  /\bnew\s+(?:instruction|rule|system\s+prompt|persona|task|role)s?\b[^\n]*/gi,
  /\byou\s+must\s+(?:now\s+)?(?:ignore|disregard|forget|obey|comply)\b[^\n]*/gi,
  /^[ \t>*\-]*(?:system|assistant|developer|user)\s*:[ \t]*/gim,
];

export interface NeutralizedPromptText {
  text: string;
  injectionDetected: boolean;
}

export function neutralizePromptText(
  input: string | null | undefined,
): NeutralizedPromptText {
  if (!input) return { text: "", injectionDetected: false };
  let text = input;
  let injectionDetected = false;
  for (const pattern of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) injectionDetected = true;
    pattern.lastIndex = 0;
    text = text.replace(pattern, " ");
  }
  return {
    text: text
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    injectionDetected,
  };
}

export function protectPromptValue(
  value: unknown,
  depth = 0,
): { value: unknown; injectionDetected: boolean } {
  if (depth > 20) {
    return { value: "<withheld:depth-limit>", injectionDetected: false };
  }
  if (typeof value === "string") {
    const protectedText = neutralizePromptText(value);
    return {
      value: protectedText.text,
      injectionDetected: protectedText.injectionDetected,
    };
  }
  if (Array.isArray(value)) {
    let injectionDetected = false;
    const protectedItems = value.slice(0, 1_000).map((item) => {
      const protectedItem = protectPromptValue(item, depth + 1);
      injectionDetected ||= protectedItem.injectionDetected;
      return protectedItem.value;
    });
    return { value: protectedItems, injectionDetected };
  }
  if (value && typeof value === "object") {
    let injectionDetected = false;
    const protectedRecord: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
      const protectedChild = protectPromptValue(child, depth + 1);
      injectionDetected ||= protectedChild.injectionDetected;
      protectedRecord[key] = protectedChild.value;
    }
    return { value: protectedRecord, injectionDetected };
  }
  return { value, injectionDetected: false };
}
