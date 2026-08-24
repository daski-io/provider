import type { ServiceRow } from "../../../../db/queries/services.js";
import type { SkillRow } from "../../../../db/queries/skills.js";
import { getSupplierConfig } from "../../../../suppliers/credentials.js";
import { escapeAttr, escapeHtml, pill } from "../../layouts.js";
import { pricingModeOf } from "./pricing.js";

export async function renderSupplierTab(args: {
  service: ServiceRow;
  skills: SkillRow[];
  managedFields: Set<"markup" | "sandbox">;
}): Promise<string> {
  const { service, skills, managedFields } = args;
  const supplier = service.supplier
    ? await getSupplierConfig(service.supplier)
    : null;
  const pricing = pricingModeOf(skills);
  const markupPct = typeof supplier?.config.markup_pct === "number"
    ? supplier.config.markup_pct
    : 0;

  const identityCard = `<section class="card workspace-card">
    <div class="workspace-card-head">
      <div class="mono-caption">Supplier binding</div>
      <span class="mono dim">adapter · ${escapeHtml(service.adapter_name)}</span>
    </div>
    <form method="POST" action="/admin/ui/config/services/${escapeAttr(service.id)}" class="settings-form">
      <input type="hidden" name="redirect_tab" value="supplier">
      <label class="field-group">
        <span class="field-label">Supplier identifier</span>
        <input class="input mono" name="supplier" value="${escapeAttr(service.supplier ?? "")}" placeholder="supplier-key">
      </label>
      <div class="setting-actions"><button class="btn btn--primary" type="submit">Save binding</button></div>
    </form>
  </section>`;

  if (!service.supplier) {
    return `<div class="workspace-stack">
      ${identityCard}
      <section class="card workspace-card">
        <p class="workspace-copy dim">Set a supplier identifier before configuring its endpoint or credentials.</p>
      </section>
    </div>`;
  }

  const revision = supplier
    ? `revision ${escapeHtml(supplier.config_revision)} · ${escapeHtml(supplier.updated_at.toISOString().slice(0, 16).replace("T", " "))}`
    : "not configured";
  const markupField = pricing.mode === "dynamic" && !managedFields.has("markup")
    ? `<label class="field-group">
        <span class="field-label">Markup (0.20 = 20%)</span>
        <input class="input mono" name="markup_pct" type="number" step="0.01" min="0" value="${escapeAttr(markupPct)}">
      </label>`
    : "";
  const endpointField = managedFields.has("sandbox")
    ? ""
    : `<label class="field-group">
        <span class="field-label">Supplier endpoint</span>
        <select class="input" name="sandbox">
          <option value="false" ${supplier?.sandbox ? "" : "selected"}>production API</option>
          <option value="true" ${supplier?.sandbox ? "selected" : ""}>sandbox API</option>
        </select>
      </label>`;
  const endpointBadge = !supplier
    ? pill("not configured", "neutral")
    : managedFields.has("sandbox")
      ? ""
      : supplier.sandbox
        ? pill("sandbox", "warning")
        : pill("production", "success");

  return `<div class="workspace-stack">
    ${identityCard}
    <section class="card workspace-card">
      <div class="workspace-card-head">
        <div>
          <div class="mono-caption">Supplier · ${escapeHtml(service.supplier)}</div>
          <div class="mono dim supplier-revision">${revision}</div>
        </div>
        ${endpointBadge}
      </div>
      <form method="POST" action="/admin/ui/config/suppliers/${escapeAttr(service.supplier)}" class="settings-form">
        <input type="hidden" name="service_id" value="${escapeAttr(service.id)}">
        ${markupField}
        ${endpointField}
        <label class="field-group full-field">
          <span class="field-label">Rotate credentials</span>
          <textarea class="input mono" name="credentials_json" rows="4" placeholder='{"apiUser":"…", "apiToken":"…"}'></textarea>
          <span class="field-hint">Leave blank to keep the current encrypted credentials.</span>
        </label>
        <div class="setting-actions"><button class="btn btn--primary" type="submit">Save supplier</button></div>
      </form>
    </section>
  </div>`;
}

export function renderEndpointsTab(service: ServiceRow): string {
  const action = `/admin/ui/config/services/${escapeAttr(service.id)}`;
  const agentCard = `/agent-cards/${encodeURIComponent(service.slug)}.json`;
  return `<div class="workspace-stack">
    <section class="card workspace-card">
      <div class="workspace-card-head"><div class="mono-caption">Email</div></div>
      <form method="POST" action="${action}" class="settings-form two-column-form">
        <input type="hidden" name="redirect_tab" value="endpoints">
        <label class="field-group">
          <span class="field-label">Outbound from</span>
          <input class="input mono" name="outbound_email_from" value="${escapeAttr(service.outbound_email_from ?? "")}">
        </label>
        <label class="field-group">
          <span class="field-label">Inbound address</span>
          <input class="input mono" name="inbound_email_address" value="${escapeAttr(service.inbound_email_address ?? "")}">
        </label>
        <p class="workspace-note full-field">Inbound replies thread into their transaction; unmatched mail escalates to the operator inbox.</p>
        <div class="setting-actions"><button class="btn btn--primary" type="submit">Save email</button></div>
      </form>
    </section>
    <section class="card workspace-card">
      <div class="workspace-card-head"><div class="mono-caption">Payouts</div></div>
      <form method="POST" action="${action}" class="settings-form">
        <input type="hidden" name="redirect_tab" value="endpoints">
        <label class="field-group full-field">
          <span class="field-label">Service wallet (optional payout override)</span>
          <input class="input mono" name="service_wallet" value="${escapeAttr(service.service_wallet ?? "")}" placeholder="0x…">
          <span class="field-hint">Leave blank to use the provider wallet.</span>
        </label>
        <div class="setting-actions"><button class="btn btn--primary" type="submit">Save payout</button></div>
      </form>
    </section>
    <section class="card workspace-card">
      <div class="workspace-card-head">
        <div class="mono-caption">Discovery</div>
        <a class="btn" href="${escapeAttr(agentCard)}" target="_blank" rel="noreferrer">Open agent card</a>
      </div>
      <div class="service-metadata-grid">
        <div><span class="field-label">Agent domain</span><span class="metadata-value mono">${escapeHtml(service.agent_domain ?? "—")}</span></div>
        <div><span class="field-label">Agent card</span><span class="metadata-value mono accent-text">${escapeHtml(agentCard)}</span></div>
      </div>
    </section>
  </div>`;
}
