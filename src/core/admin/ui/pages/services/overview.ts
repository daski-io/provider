import type { AssetRow } from "../../../../db/queries/assets.js";
import type { ServiceRow } from "../../../../db/queries/services.js";
import type { AdminAssetAction } from "../../../../serviceRegistry/types.js";
import { escapeAttr, escapeHtml } from "../../layouts.js";
import { assetStatusPill, fullOnChainId } from "./shared.js";

function metadataField(label: string, value: string, accent = false): string {
  return `<div>
    <span class="field-label">${escapeHtml(label)}</span>
    <span class="metadata-value mono${accent ? " accent-text" : ""}" title="${escapeAttr(value)}">${escapeHtml(value)}</span>
  </div>`;
}

export function renderOverviewTab(args: {
  service: ServiceRow;
  assets: AssetRow[];
  assetTotal: number;
  assetActions: AdminAssetAction[];
}): string {
  const { service, assets, assetTotal, assetActions } = args;
  const hasActions = assetActions.length > 0;
  const rows = assets.map((asset) => {
    const buttons = assetActions
      .filter((action) => action.appliesTo.includes(asset.status))
      .map((action) => `<form method="POST" action="/admin/ui/services/${escapeAttr(service.id)}/assets/${escapeAttr(asset.id)}/actions/${escapeAttr(action.id)}" class="asset-action-form">
          <button class="btn" type="submit" ${action.confirm ? `data-confirm="${escapeAttr(action.confirm)}"` : ""}>${escapeHtml(action.label)}</button>
        </form>`)
      .join("");
    return `<tr>
      <td class="mono">${escapeHtml(asset.identifier)}</td>
      <td class="mono dim">${escapeHtml(asset.type)}</td>
      <td>${assetStatusPill(asset.status)}</td>
      <td class="mono dim">${asset.expires_at ? escapeHtml(asset.expires_at.toISOString().slice(0, 10)) : "—"}</td>
      ${hasActions ? `<td><div class="asset-actions">${buttons || '<span class="dim">—</span>'}</div></td>` : ""}
    </tr>`;
  }).join("");

  return `<div class="workspace-stack">
    <section class="card workspace-card">
      <div class="workspace-card-head"><div class="mono-caption">About</div></div>
      <p class="service-description">${escapeHtml(service.service_description)}</p>
      <div class="service-metadata-grid">
        ${metadataField("On-chain id", fullOnChainId(service) ?? "not registered", true)}
        ${metadataField("Agent domain", service.agent_domain ?? "—")}
        ${metadataField("Adapter", service.adapter_name)}
        ${metadataField("Supplier", service.supplier ?? "—")}
        ${metadataField("Category", `${service.category_family} / ${service.service_type}`)}
        ${metadataField("Lifecycle", service.service_lifecycle)}
      </div>
    </section>
    <section>
      <div class="section-heading">
        <div class="mono-caption">Assets</div>
        <span class="mono dim">showing ${assets.length} of ${assetTotal} · newest first</span>
      </div>
      <div class="card workspace-table-card">
        ${assets.length
          ? `<div class="table-scroll"><table class="workspace-table">
              <thead><tr><th>Identifier</th><th>Type</th><th>Status</th><th>Expires</th>${hasActions ? "<th>Actions</th>" : ""}</tr></thead>
              <tbody>${rows}</tbody>
            </table></div>`
          : '<p class="services-empty dim">No assets registered for this service.</p>'}
      </div>
      ${hasActions ? '<p class="workspace-note">Asset actions require confirmation and write a platform-log event with your wallet as actor.</p>' : ""}
    </section>
  </div>`;
}
