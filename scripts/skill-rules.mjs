import { readFileSync } from "node:fs";
import { join } from "node:path";

// Consistency rules shared by the skill validator and the documentation
// check: routing statements must not contradict the three integration paths
// (lite synchronous, lite external job, provider-full), and code-like
// references to the adapter API and the reviewed outbound HTTP helpers must
// name members, outcomes and exports the checked-out source actually
// declares.

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

/** The reviewed outbound HTTP helpers a product client uses instead of `fetch`. */
const OUTBOUND_MODULES = ["outboundHttp.ts", "pinnedHttp.ts", "reviewedEndpoint.ts"]
  .map((name) => `src/core/security/${name}`);

/**
 * The adapter API as `src/core/serviceRegistry/adapterTypes.ts` and
 * `serviceModule.ts` declare it: interface members, adapter modes, outcome
 * kinds, safe-to-start bases and call-issue codes; and the names the reviewed
 * outbound HTTP modules export.
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
    outboundHelpers: new Set(OUTBOUND_MODULES.flatMap((path) => [...literals(
      readFileSync(join(root, path), "utf8"),
      /^export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    )])),
  };
}

const FILE_EXTENSION = /^(?:json|md|ts|js|mjs|cjs|sql|ya?ml|txt|env)$/;
// Code fences may be indented inside list items.
const FENCE = /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

/** Inline code spans and fenced code blocks: where API references live. */
function codeFragments(text) {
  const fenced = [...text.matchAll(FENCE)].map((match) => match[1]);
  const prose = text.replace(FENCE, "");
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...fenced, ...inline];
}

// Hook-like calls an agent might invent for lifecycle work lite does not have.
const INVENTED_HOOKS = /\b(cancel|handleInput|resume|resumeJob|startJob|pollJob|getStatus|checkStatus|onWebhook|onComplete|retryFailedOrder|reopen)\s*\(\s*context\b/g;
// Names shaped like the reviewed outbound helpers (`boundedFetch`,
// `pinnedHttpRequest`, `reviewedEndpoint`), such as the nonexistent
// `PinnedHttpClient`, must be one of their exports; module paths and file
// names (`src/core/security/pinnedHttp.ts`) are not references.
const OUTBOUND_HELPER = /(?<![\w./-])((?:[Bb]ounded|[Pp]inned|[Rr]eviewed)(?:Http|Fetch|Endpoint|Request|Response|Client|Url|URL)\w*)(?!\w|\.[a-z]{1,4}\b)/g;
const ADAPTER_CONTEXT = /\b(?:adapter|ExternalJobAdapter|FulfillmentAdapter|recoverStart|execute\s*\(|start\s*\(|poll\s*\()/;
const literal = (key) => new RegExp(`["']?\\b${key}["']?\\s*:\\s*["']([a-z]+(?:-[a-z]+)*)["']`, "g");

/**
 * Code-like references to adapter members (`context.x`, `adapter.x`,
 * `ServiceModule.x`, ...), invented lifecycle hooks, outcome literals
 * (`kind: "x"`, `basis: "x"`, an adapter's `mode: "x"`, an issue's
 * `code: "x"`) and outbound helper names that the source does not declare.
 * Paths and file names (`tests/adapter.test.ts`, `context.json`) are not
 * references.
 */
export function findUnknownAdapterReferences(text, api) {
  const problems = [];
  for (const fragment of codeFragments(text)) {
    for (const match of fragment.matchAll(/(^|[^\w./-])(context|adapter|TaskContext|ExternalJobContext|FulfillmentAdapter|ExternalJobAdapter|ServiceModule)\.([A-Za-z_][A-Za-z0-9_]*)(\.[a-z]{1,4}\b)?/g)) {
      const [, , owner, member, extension] = match;
      if (extension || FILE_EXTENSION.test(member)) continue;
      if (!api.members.get(owner)?.has(member)) problems.push(`${owner}.${member} is not a declared member`);
    }
    for (const match of fragment.matchAll(INVENTED_HOOKS)) {
      problems.push(`${match[1]}(context, ...) is not a declared adapter hook`);
    }
    for (const match of fragment.matchAll(OUTBOUND_HELPER)) {
      if (!api.outboundHelpers.has(match[1])) problems.push(`${match[1]} is not an exported outbound HTTP helper`);
    }
    const checks = [
      [literal("kind"), api.kinds, "outcome kind"],
      [literal("basis"), api.bases, "safe-to-start basis"],
      [/["']?\bissue["']?\s*:\s*\{\s*["']?code["']?\s*:\s*["']([^"']+)["']/g, api.issueCodes, "call-issue code"],
    ];
    if (ADAPTER_CONTEXT.test(fragment)) checks.push([literal("mode"), api.modes, "adapter mode"]);
    for (const [pattern, allowed, label] of checks) {
      for (const match of fragment.matchAll(pattern)) {
        if (!allowed.has(match[1])) problems.push(`"${match[1]}" is not a declared ${label}`);
      }
    }
  }
  return [...new Set(problems)];
}

/** Sentences of prose, list items and table rows, code removed. */
function sentences(text) {
  const prose = text.replace(FENCE, "").replace(/`([^`\n]+)`/g, "$1");
  const units = [];
  for (const block of prose.split(/\n\s*\n/)) {
    const items = [];
    for (const line of block.split("\n")) {
      if (/^\s*\|/.test(line) || /^\s*(?:[-*+]|\d+\.)\s/.test(line) || items.length === 0) items.push(line);
      else items[items.length - 1] += ` ${line.trim()}`;
    }
    for (const item of items) units.push(...item.trim().split(/(?<=[.!?])\s+(?=[A-Z`(])/));
  }
  return units.map((unit) => unit.trim()).filter(Boolean);
}

/**
 * The clauses of one sentence: a rule and its negation must meet in one
 * clause, so "X; provider-full is for Y" never reads as one statement.
 */
const clausesOf = (sentence) => sentence.split(/;\s+|:\s+|\s+—\s+|\s\|\s/).map((part) => part.trim()).filter(Boolean);

const NEGATION = /\b(?:not|no|never|nothing|none|without|cannot|can't|neither|nor|unsupported|excluded|deferred|alone)\b/i;
const STRICT_NEGATION = /\b(?:not|no|never|none|cannot|can't|neither|nor|unsupported|excluded)\b/i;
const FULL = String.raw`(?:provider-full|the full starter|full starter)`;
const LITE = String.raw`(?:lite|the minimal (?:starter|provider)|minimal (?:starter|provider)|this repository|the lite starter)`;
const DURATION = String.raw`(?:long[- ]running|lengthy|long jobs?|minutes?|hours?|days?|duration|eight-hour|asynchronous|more than (?:a|\d+) (?:seconds?|minutes?|hours?))`;

/**
 * Retired phrasings of the old single routing rule, and claims of
 * capabilities lite lacks. A heuristic list, not a parser: it catches the
 * statements the three-path rule replaced.
 */
const CONTRADICTIONS = [
  {
    // Every 50-second limit belongs to the synchronous mode, said in the
    // same sentence or table row.
    scope: "sentence",
    pattern: /\b50[- ]seconds?\b|\b50 ?s\b|\bfifty seconds\b/i,
    unless: /\bsynchronous|\bsync\b|\bdrain/i,
    reason: "a 50-second limit must be scoped to the synchronous mode",
  },
  {
    pattern: new RegExp(String.raw`\b${DURATION}\b.*\b${FULL}\b|\b${FULL}\b.*\b${DURATION}\b`, "i"),
    unless: NEGATION,
    reason: "duration alone never selects provider-full",
  },
  {
    pattern: new RegExp(String.raw`\b(?:(?:when|if)\s+(?:the\s+)?(?:fit\s+is\s+)?uncertain|when in doubt|(?:if|when)\s+(?:you(?:'re| are)\s+)?unsure)\b.*\b(?:prefer|choose|start|use|pick)\b.*(?:\b${FULL}|\bfull\b|\bthere\b)|\bstart there when uncertain\b`, "i"),
    unless: /$^/,
    reason: "uncertainty is resolved with product facts, not by defaulting to provider-full",
  },
  {
    pattern: new RegExp(String.raw`\bcannot\s+(?:finish|complete|be completed)\s+synchronously,?\s+(?:stop\s+and\s+)?(?:use|move\s+it\s+to|migrate\s+the\s+work\s+to)\s+${FULL}`, "i"),
    unless: /$^/,
    reason: "an ambiguity that outlives the call is an external job or an upstream gap, not automatically provider-full",
  },
  {
    scope: "sentence",
    pattern: /^\|\s*Product job continues after (?:the )?HTTP response\s*\|\s*Not supported\s*\|\s*Supported\s*\|\s*$/i,
    unless: /$^/,
    reason: "lite external-job mode supports product jobs that continue after the response",
  },
  {
    pattern: new RegExp(String.raw`\b${LITE}\b.*\b(?:does not|doesn't|cannot|can't|can not|never)\s+(?:support|run|handle|carry)\b.*\b(?:product jobs?|jobs?|long-running|asynchronous|work that continues)\b|\b${LITE}\b.*\b(?:only supports? synchronous|supports? only synchronous|synchronous[- ]only)\b`, "i"),
    unless: /$^/,
    reason: "lite external-job mode runs product jobs that outlive the call",
  },
  {
    pattern: new RegExp(String.raw`\b${LITE}\b.*\b(?:supports?|handles?|offers?|provides?|enables?)\b.*\b(?:dynamic pric\w*|cancell?ation|later (?:buyer )?input|owner actions|human review|multi-replica|direct A2A)\b`, "i"),
    unless: STRICT_NEGATION,
    reason: "lite does not support this full-only capability",
  },
  {
    pattern: /\b(?:supports?|offers?|provides?|enables?|promises?)\b.*\b(?:paid recovery|recovery after (?:a )?(?:provider-)?terminal|reopen\w* (?:a )?(?:failed|terminal))/i,
    unless: STRICT_NEGATION,
    reason: "recovery after a provider-terminal paid failure is not an available capability",
  },
];

/** Routing statements that contradict the three-path rule. */
export function findRoutingContradictions(text) {
  const problems = [];
  for (const sentence of sentences(text)) {
    for (const rule of CONTRADICTIONS) {
      for (const unit of rule.scope === "sentence" ? [sentence] : clausesOf(sentence)) {
        if (rule.pattern.test(unit) && !rule.unless.test(unit)) {
          problems.push(`${rule.reason}: "${unit.slice(0, 160)}"`);
        }
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * References an installed copy of the skill cannot follow: the evaluation
 * briefs the package is judged by (their directory or case ids) and test
 * fixtures named as if the reader had them ("the second fixture"). The
 * installed package is all its reader has, so such a case is described as a
 * scenario instead. Only the packaged skill is held to this; the
 * repository's own guides may link the briefs.
 */
export function findEvaluationReferences(text) {
  const pattern = /skill-evaluations|\bS-T\d{2}\b|\b(?:first|second|third|fourth|another|other|previous|next)\s+fixtures?\b/gi;
  return [...new Set([...text.matchAll(pattern)].map((match) =>
    `refers to an evaluation fixture an installed skill does not include: "${match[0]}"`))];
}
