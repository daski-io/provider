export interface AdapterApi {
  members: Map<string, Set<string>>;
  modes: Set<string>;
  kinds: Set<string>;
  bases: Set<string>;
  issueCodes: Set<string>;
}

export function readAdapterApi(root: string): AdapterApi;
export function findUnknownAdapterReferences(text: string, api: AdapterApi): string[];
export function findRoutingContradictions(text: string): string[];
