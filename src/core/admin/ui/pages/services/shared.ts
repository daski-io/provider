import {
  countActiveAssetsByService,
} from "../../../../db/queries/assets.js";
import type { ServiceRow } from "../../../../db/queries/services.js";
import { countTransactionsByService } from "../../../../db/queries/transactions.js";
import { escapeAttr, escapeHtml, pill } from "../../layouts.js";

export interface ServiceKpis {
  activeAssets: number;
  transactions7d: number;
  transactions30d: number;
}

export async function loadServiceKpis(serviceId: string): Promise<ServiceKpis> {
  const now = Date.now();
  const d7 = new Date(now - 7 * 24 * 3600 * 1000);
  const d30 = new Date(now - 30 * 24 * 3600 * 1000);
  const [activeAssets, transactions7d, transactions30d] =
    await Promise.all([
      countActiveAssetsByService(serviceId),
      countTransactionsByService(serviceId, d7),
      countTransactionsByService(serviceId, d30),
    ]);
  return {
    activeAssets,
    transactions7d,
    transactions30d,
  };
}

export function activePill(active: boolean): string {
  return active ? pill("active", "success") : pill("inactive", "neutral");
}

export function fullOnChainId(service: ServiceRow): string | null {
  return service.on_chain_id ? `0x${service.on_chain_id.toString("hex")}` : null;
}

export function onChainDisplay(service: ServiceRow): string {
  const full = fullOnChainId(service);
  if (!full) return pill("not registered", "warning");
  const short = `${full.slice(0, 10)}…${full.slice(-4)}`;
  return `<span class="mono service-chain-id" title="${escapeAttr(full)}">${escapeHtml(short)}</span>`;
}

export function assetStatusPill(status: string): string {
  const tone = status === "active"
    ? "success"
    : status === "suspended" || status === "expiring"
      ? "warning"
      : status === "pending" || status === "provisioning"
        ? "info"
        : "neutral";
  return pill(status, tone);
}
