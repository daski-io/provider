import type { Hex } from "viem";

export interface ServiceArtifact {
  name: string;
  data?: Record<string, unknown>;
  url?: string;
  mimeType?: string;
}

export type ServiceResult =
  | {
      status: "completed";
      message?: string;
      artifacts?: ServiceArtifact[];
    }
  | {
      status: "failed";
      message?: string;
      errorCode: string;
    };

export interface TaskContext {
  taskId: string;
  orderId: string;
  payer: Hex;
  serviceSlug: string;
  skillId: string;
  /** Aborted when the provider's synchronous execution budget expires. */
  signal: AbortSignal;
}

export interface FulfillmentAdapter {
  execute(
    context: TaskContext,
    input: Record<string, unknown>,
  ): Promise<ServiceResult>;
}
