import { getServiceBySlug } from "../db/queries/services.js";
import { logError } from "../logger.js";
import { getAllServices } from "../serviceRegistry/registry.js";
import type { ServiceModule } from "../serviceRegistry/types.js";

export interface InboundInterceptorMatch {
  interceptor: {
    module: ServiceModule;
    serviceRow: NonNullable<Awaited<ReturnType<typeof getServiceBySlug>>>;
  } | null;
  failed: boolean;
}

/** Resolve a recipient to exactly one active service interceptor. */
export async function findInboundInterceptor(
  recipient: string,
): Promise<InboundInterceptorMatch> {
  let match: InboundInterceptorMatch["interceptor"] = null;
  let failed = false;
  for (const module of getAllServices()) {
    if (!module.protocol.inboundEmail) continue;
    try {
      if (!await module.protocol.inboundEmail.match(recipient)) continue;
      const serviceRow = await getServiceBySlug(
        module.manifest.slug,
        module.manifest.version ?? "1",
      );
      if (!serviceRow?.is_active || match) {
        failed = true;
        continue;
      }
      match = { module, serviceRow };
    } catch (error) {
      failed = true;
      logError("inbound interceptor match threw", {
        service: module.manifest.slug,
        error: (error as Error).message,
      });
    }
  }
  return { interceptor: failed ? null : match, failed };
}
