import { readFileSync } from "node:fs";
import { join } from "node:path";

// Consistency rules shared by the skill validator and the documentation
// check: routing statements must not contradict the three integration paths
// (lite synchronous, lite external job, provider-full), and code-like
// references to the adapter API must name members and outcomes the
// checked-out source actually declares.

/** The body of `interface <name> ... { ... }`, braces matched. */
function interfaceBody(source, name) {
  const start = new RegExp(`\\binterface\\s+${name}\\b[^{]*\\{`).exec(source);
  if (!start) return null;
  let depth = 1;
  let index = start.index + start[0].length;
  const begin = index;
  while (index < source.length && depth > 0) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    index += 1;
  }
  return source.slice(begin, index - 1);
}

/** Top-level member names of an interface body (two-space indentation). */
function memberNames(body) {
  return new Set([...body.matchAll(/^ {2}(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*[(:]/gm)]
    .map((match) => match[1]));
}

const literals = (source, pattern) => new Set([...source.matchAll(pattern)].map((match) => match[1]));

/**
 * The adapter API as `src/core/serviceRegistry/adapterTypes.ts` and
 * `serviceModule.ts` declare it: interface members, adapter modes, outcome
 * kinds, safe-to-start bases and call-issue codes.
 */
export function readAdapterApi(root) {
  const adapterTypes = readFileSync(join(root, "src/core/serviceRegistry/adapterTypes.ts"), "utf8");
  const serviceModule = readFileSync(join(root, "src/core/serviceRegistry/serviceModule.ts"), "utf8");
  const members = (source, name) => {
    const body = interfaceBody(source, name);
    if (body === null) throw new Error(`adapter API interface ${name} was not found`);
    return memberNames(body);
  };
  const task = members(adapterTypes, "TaskContext");
  const jobContext = new Set([...task, ...members(adapterTypes, "ExternalJobContext")]);
  const adapter = new Set([
    ...members(adapterTypes, "FulfillmentAdapter"),
    ...members(adapterTypes, "ExternalJobAdapter"),
  ]);
  const module = members(serviceModule, "ServiceModule");
  const callIssue = /type\s+CallIssue\s*=\s*\{([\s\S]*?)\};/.exec(adapterTypes)?.[1] ?? "";
  return {
    members: new Map([
      ["context", jobContext],
      ["TaskContext", task],
      ["ExternalJobContext", jobContext],
      ["adapter", adapter],
      ["FulfillmentAdapter", members(adapterTypes, "FulfillmentAdapter")],
      ["ExternalJobAdapter", members(adapterTypes, "ExternalJobAdapter")],
      ["module", module],
      ["ServiceModule", module],
    ]),
    modes: literals(adapterTypes, /\bmode\??:\s*"([^"]+)"/g),
    kinds: literals(adapterTypes, /\bkind:\s*"([^"]+)"/g),
    bases: literals(/basis:\s*([^;}]+)/.exec(adapterTypes)?.[1] ?? "", /"([^"]+)"/g),
    issueCodes: literals(callIssue, /"([a-z_]+)"/g),
  };
}

const FILE_EXTENSION = /^(?:json|md|ts|js|mjs|cjs|sql|ya?ml|txt|env)$/;

/** Inline code spans and fenced code blocks: where API references live. */
function codeFragments(text) {
  const fenced = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...fenced, ...inline];
}

/**
 * Code-like references to adapter members (`context.x`, `adapter.x`,
 * `ServiceModule.x`, ...) and outcome literals (`kind: "x"`, `basis:
 * "x"`, `mode: "x"`, an issue's `code: "x"`) that the API does not declare.
 */
export function findUnknownAdapterReferences(text, api) {
  const problems = [];
  for (const fragment of codeFragments(text)) {
    for (const match of fragment.matchAll(/\b(context|adapter|module|TaskContext|ExternalJobContext|FulfillmentAdapter|ExternalJobAdapter|ServiceModule)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const [, owner, member] = match;
      if (FILE_EXTENSION.test(member)) continue;
      if (!api.members.get(owner)?.has(member)) problems.push(`${owner}.${member} is not a declared member`);
    }
    for (const [pattern, allowed, label] of [
      [/\bkind:\s*"([^"]+)"/g, api.kinds, "outcome kind"],
      [/\bbasis:\s*"([^"]+)"/g, api.bases, "safe-to-start basis"],
      [/\bmode:\s*"([^"]+)"/g, api.modes, "adapter mode"],
      [/\bissue:\s*\{\s*code:\s*"([^"]+)"/g, api.issueCodes, "call-issue code"],
    ]) {
      for (const match of fragment.matchAll(pattern)) {
        if (!allowed.has(match[1])) problems.push(`"${match[1]}" is not a declared ${label}`);
      }
    }
  }
  return [...new Set(problems)];
}

/** Sentences of prose and single table rows, code removed. */
function statements(text) {
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "").replace(/`([^`\n]+)`/g, "$1");
  const units = [];
  for (const block of prose.split(/\n\s*\n/)) {
    const rows = block.split("\n");
    if (rows.every((row) => row.trimStart().startsWith("|"))) {
      units.push(...rows);
      continue;
    }
    units.push(...block.replace(/\s*\n\s*/g, " ").split(/(?<=[.!?])\s+(?=[A-Z`(])/));
  }
  return units.map((unit) => unit.trim()).filter(Boolean);
}

const NEGATION = /\b(?:not|no|never|nothing|none|without|cannot|neither|nor|unsupported|excluded|deferred|alone)\b/i;

/** Statements of the retired single rule or of capabilities lite does not have. */
const CONTRADICTIONS = [
  {
    // Every 50-second limit belongs to the synchronous mode.
    pattern: /\b50[- ]seconds?\b|\b50 s\b/i,
    unless: /\bsynchronous|\bsync\b|\bdrain/i,
    reason: "a 50-second limit must be scoped to the synchronous mode",
  },
  {
    pattern: /\b(?:long[- ]running|lengthy|long jobs?|hours?|minutes|duration|eight-hour|runtime)\b[^|]*\bprovider-full\b|\bprovider-full\b[^|]*\b(?:long[- ]running|lengthy|long jobs?|hours?|minutes|duration|eight-hour)\b/i,
    unless: NEGATION,
    reason: "duration alone never selects provider-full",
  },
  {
    pattern: /\b(?:when|if)\s+(?:the\s+)?(?:fit\s+is\s+)?uncertain\b[^.|]*\b(?:prefer|choose|start|use)\b[^.|]*\b(?:full|provider-full|there)\b|\bstart there when uncertain\b/i,
    unless: /$^/,
    reason: "uncertainty is resolved with product facts, not by defaulting to provider-full",
  },
  {
    pattern: /\bcannot\s+(?:finish|complete|be completed)\s+synchronously,?\s+(?:stop\s+and\s+)?(?:use|move\s+it\s+to|migrate\s+the\s+work\s+to)\s+provider-full\b/i,
    unless: /$^/,
    reason: "an ambiguity that outlives the call is an external job or an upstream gap, not automatically provider-full",
  },
  {
    pattern: /^\|\s*Product job continues after (?:the )?HTTP response\s*\|\s*Not supported\s*\|\s*Supported\s*\|\s*$/i,
    unless: /$^/,
    reason: "lite external-job mode supports product jobs that continue after the response",
  },
  {
    pattern: /\b(?:lite|minimal (?:starter|provider)|this repository)\b[^.|]*\b(?:does not|doesn't|cannot|never)\s+(?:support|run|handle|carry)\b[^.|]*\b(?:product jobs?|long-running|asynchronous jobs?|work that continues)\b/i,
    unless: /$^/,
    reason: "lite external-job mode runs product jobs that outlive the call",
  },
  {
    pattern: /\b(?:lite|minimal (?:starter|provider)|this repository|the provider starter)\b[^.|]*\b(?:supports?|handles?|offers?|provides?|enables?)\b[^.|]*\b(?:dynamic pric\w*|cancell?ation|later (?:buyer )?input|owner actions|human review|multi-replica|direct A2A)\b/i,
    unless: NEGATION,
    reason: "lite does not support this full-only capability",
  },
  {
    pattern: /\b(?:supports?|offers?|provides?|enables?|promises?)\b[^.|]*\b(?:paid recovery|recovery after (?:a )?(?:provider-)?terminal|reopen\w* (?:a )?(?:failed|terminal))/i,
    unless: NEGATION,
    reason: "recovery after a provider-terminal paid failure is not an available capability",
  },
];

/** Routing statements that contradict the three-path rule. */
export function findRoutingContradictions(text) {
  const problems = [];
  for (const statement of statements(text)) {
    for (const rule of CONTRADICTIONS) {
      if (rule.pattern.test(statement) && !rule.unless.test(statement)) {
        problems.push(`${rule.reason}: "${statement.slice(0, 160)}"`);
      }
    }
  }
  return problems;
}
