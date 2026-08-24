import type { AdapterResult } from "../serviceRegistry/types.js";

/** Convert the typed adapter contract into canonical-JSON storage form. */
export function adapterResultForStorage(
  result: AdapterResult,
): Record<string, unknown> {
  const stored: Record<string, unknown> = { status: result.status };

  if (result.message !== undefined) stored.message = result.message;
  if (result.error !== undefined) stored.error = result.error;
  if (result.failureClass !== undefined) stored.failureClass = result.failureClass;
  if (result.autoRefundContext !== undefined) {
    stored.autoRefundContext = result.autoRefundContext;
  }
  if (result.artifacts !== undefined) {
    stored.artifacts = result.artifacts.map((artifact) => ({
      name: artifact.name,
      ...(artifact.data !== undefined ? { data: artifact.data } : {}),
      ...(artifact.url !== undefined ? { url: artifact.url } : {}),
      ...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
    }));
  }
  if (result.asset !== undefined) {
    stored.asset = {
      assetType: result.asset.assetType,
      assetIdentifier: result.asset.assetIdentifier,
      assetData: result.asset.assetData,
      ...(result.asset.expiresAt !== undefined
        ? { expiresAt: result.asset.expiresAt.toISOString() }
        : {}),
    };
  }

  return stored;
}
