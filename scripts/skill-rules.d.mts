export interface AdapterApi {
  members: Map<string, Set<string>>;
  modes: Set<string>;
  kinds: Set<string>;
  bases: Set<string>;
  issueCodes: Set<string>;
  outboundHelpers: Set<string>;
}

export const SKILL_MAX_LINES: number;
export function countLines(text: string): number;
export function readAdapterApi(root: string): AdapterApi;
export function findUnknownAdapterReferences(text: string, api: AdapterApi): string[];
export function findRoutingContradictions(text: string): string[];
export function findEvaluationReferences(text: string): string[];
