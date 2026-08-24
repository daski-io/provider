import type {
  AssetRow,
  AssetStatus,
} from "../db/queries/assets.js";
import type { InboundEmailRow } from "../db/queries/emails.js";

export interface PreExecuteAgentConfig {
  systemPrompt: string;
  escalationRules: string;
  model: string;
  enabled: boolean;
  timeoutMs: number;
  onError?: "proceed" | "escalate";
}

export type PreExecuteDecision =
  | { action: "proceed" }
  | { action: "reject"; reason: string }
  | { action: "escalate"; reviewQuestion: string };

export interface ServiceMigration {
  name: string;
  sql: string;
}

export interface AdminAssetAction {
  id: string;
  label: string;
  confirm?: string;
  appliesTo: AssetStatus[];
  /**
   * Execute an action and return its result. Any local state mutation and
   * mandatory admin audit must commit in the same database transaction.
   */
  run(asset: AssetRow, actor: string): Promise<string>;
}

export interface ServiceAdminExtension {
  assetActions?: AdminAssetAction[];
  genericSupplierFieldsManaged?: Array<"markup" | "sandbox">;
  configPanelLabel?: string;
  configPanelHtml?(): Promise<string>;
  /**
   * Handle service controls. Implementations own mandatory audit records and
   * transaction boundaries for every state-changing action.
   */
  handleConfigAction?(
    action: string,
    form: URLSearchParams,
    actor: string,
  ): Promise<string>;
}

export interface InboundEmailInterceptor {
  match(recipient: string): Promise<boolean> | boolean;
  handle(row: InboundEmailRow): Promise<void>;
}

export interface PreExecuteReviewDataArgs {
  skillId: string;
  data: Record<string, unknown>;
  asset: AssetRow | null;
}

export interface ServiceReadiness {
  requiredWorkers?: string[];
  checkInvariants?(): Promise<string[]> | string[];
}
