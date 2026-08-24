import type { InboundEmailRow } from "../../../db/queries/emails.js";
import type { Tool, ToolDefinition } from "../../types.js";

export type { Tool, ToolDefinition };

export type EmailAuthorizationContext =
  | { kind: "unauthenticated" }
  | {
      kind: "authenticated";
      customerId: string;
      walletAddress: string;
      transactionIds: string[];
      assetIds: string[];
      expiresAt: Date;
      method: "wallet";
    };

// Per-call context threaded through every Email Agent tool. Carries the
// inbound email being triaged, the resolved service id, and the outbound
// from-address so reply/forward tools thread correctly. Tools mutate
// `inbound.transaction_id` / `inbound.customer_id` in place when they link
// a transaction so later tools in the same run stamp the same ids.
export interface EmailAgentContext {
  inbound: InboundEmailRow;
  serviceId: string;
  /** The service's slug — used to scope which tools are visible. */
  serviceSlug: string;
  /** The outbound from-address for this service (services.outbound_email_from). */
  fromAddress: string;
  /** Sender addresses are never principals. Only wallet proof can
   *  populate an authenticated context; ordinary Postmark mail is always
   *  unauthenticated, regardless of SPF/DKIM or a matching contact email. */
  authorization: EmailAuthorizationContext;
}

// An Email Agent tool. The `scope` field (inherited from Tool) declares
// which service slugs the tool applies to; the registry stamps a default
// of `[<own slug>]` on service-contributed tools and treats shared tools
// (no scope) as `"all"`.
export type EmailAgentTool = Tool<EmailAgentContext>;
