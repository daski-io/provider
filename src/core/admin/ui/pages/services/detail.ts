import type { Request } from "express";
import {
  countAssetsByService,
  listAssets,
} from "../../../../db/queries/assets.js";
import { listServiceRules } from "../../../../db/queries/serviceRules.js";
import { getServiceById } from "../../../../db/queries/services.js";
import { getSkillsByServiceId } from "../../../../db/queries/skills.js";
import { getService } from "../../../../serviceRegistry/registry.js";
import {
  escapeAttr,
  escapeHtml,
  renderLayout,
} from "../../layouts.js";
import {
  parseServiceWorkspaceTab,
  serviceWorkspaceUrl,
  type ServiceWorkspaceTab,
} from "./navigation.js";
import { renderOverviewTab } from "./overview.js";
import { renderPricingTab } from "./pricing.js";
import { renderRulesTab } from "./rules.js";
import { renderEndpointsTab, renderSupplierTab } from "./settings.js";
import {
  activePill,
  loadServiceKpis,
  onChainDisplay,
} from "./shared.js";
import { adminActionFailure } from "../../actionFailure.js";

interface WorkspaceTab {
  id: ServiceWorkspaceTab;
  label: string;
}

function flash(req: Request): string {
  const query = req.query as Record<string, string | undefined>;
  if (query.ok) return `<div class="flash flash--success">${escapeHtml(query.ok)}</div>`;
  if (query.err) return `<div class="flash flash--danger">${escapeHtml(query.err)}</div>`;
  return "";
}

function renderControls(panel: string): string {
  if (!panel) {
    return `<section class="card workspace-card"><p class="workspace-copy dim">This service has no additional controls.</p></section>`;
  }
  return `<section class="card workspace-card service-controls"><div class="service-controls-scroll">${panel}</div></section>`;
}

export async function renderServiceDetail(
  serviceId: string,
  walletShort: string | undefined,
  req: Request,
): Promise<string | null> {
  const service = await getServiceById(serviceId);
  if (!service) return null;
  const serviceModule = getService(service.slug);
  const extension = serviceModule?.admin;
  const [skills, assets, assetTotal, rules, kpi] = await Promise.all([
    getSkillsByServiceId(serviceId),
    listAssets({ serviceId, limit: 100 }),
    countAssetsByService(serviceId),
    listServiceRules({ service_id: serviceId, active_only: false }),
    loadServiceKpis(serviceId),
  ]);
  const managedFields = new Set(extension?.genericSupplierFieldsManaged ?? []);
  const tabs: WorkspaceTab[] = [
    { id: "overview", label: "Overview" },
    { id: "pricing", label: "Skills & pricing" },
    { id: "supplier", label: extension?.configPanelHtml ? "Supplier" : "Supplier & catalog" },
    ...(extension?.configPanelHtml
      ? [{
          id: "controls" as const,
          label: extension.configPanelLabel ?? "Service controls",
        }]
      : []),
    { id: "rules", label: "Rules" },
    { id: "endpoints", label: "Email & endpoints" },
  ];
  const requestedTab = parseServiceWorkspaceTab(req.query.tab);
  const tab = tabs.some((item) => item.id === requestedTab) ? requestedTab : "overview";

  let tabBody: string;
  if (tab === "overview") {
    tabBody = renderOverviewTab({
      service,
      assets,
      assetTotal,
      assetActions: extension?.assetActions ?? [],
    });
  } else if (tab === "pricing") {
    tabBody = renderPricingTab({
      service,
      skills,
      markupManaged: managedFields.has("markup"),
    });
  } else if (tab === "supplier") {
    tabBody = await renderSupplierTab({ service, skills, managedFields });
  } else if (tab === "controls") {
    try {
      tabBody = renderControls(await extension?.configPanelHtml?.() ?? "");
    } catch (error) {
      tabBody = `<section class="card workspace-card"><p class="dim">${escapeHtml(
        adminActionFailure("service.controls.render", error),
      )}</p></section>`;
    }
  } else if (tab === "rules") {
    tabBody = renderRulesTab({ service, skills, rules });
  } else {
    tabBody = renderEndpointsTab(service);
  }

  const hero = `<section class="card service-hero">
    <div class="service-identity-row">
      <div class="service-mark" aria-hidden="true">${escapeHtml(service.name.slice(0, 1).toUpperCase())}</div>
      <div class="service-identity">
        <div class="service-title-line">
          <h1>${escapeHtml(service.name)}</h1>
          ${activePill(service.is_active)}
        </div>
        <div class="service-identity-meta mono">
          <span>${escapeHtml(service.slug)} v${escapeHtml(service.version)} · ${escapeHtml(service.category_family)} / ${escapeHtml(service.service_type)} · ${escapeHtml(service.service_lifecycle)}</span>
          ${onChainDisplay(service)}
        </div>
      </div>
      <div class="service-hero-actions">
        <form method="POST" action="/admin/ui/config/services/${escapeAttr(service.id)}" class="service-status-form">
          <input type="hidden" name="redirect_tab" value="overview">
          <input type="hidden" name="is_active_present" value="true">
          <label class="switch-control">
            <input type="checkbox" name="is_active" ${service.is_active ? "checked" : ""}>
            <span class="switch-track" aria-hidden="true"><span></span></span>
            <span>Accept tasks</span>
          </label>
          <button class="btn" type="submit">Save status</button>
        </form>
        <a class="btn" href="/agent-cards/${encodeURIComponent(service.slug)}.json" target="_blank" rel="noreferrer">Agent card</a>
      </div>
    </div>
    <div class="service-kpis">
      <div><span class="mono-caption">Active assets</span><strong>${kpi.activeAssets}</strong></div>
      <div><span class="mono-caption">Tx · 7d</span><strong>${kpi.transactions7d}</strong><span class="mono dim">${kpi.transactions30d} · 30d</span></div>
      <div><span class="mono-caption">Skills</span><strong>${skills.length}</strong><span class="mono dim">${rules.length} rules</span></div>
    </div>
  </section>`;

  const tabLinks = tabs.map((item) => {
    const active = item.id === tab;
    return `<a class="workspace-tab${active ? " active" : ""}" href="${escapeAttr(serviceWorkspaceUrl(service.id, item.id))}"${active ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`;
  }).join("");
  const body = `<div class="service-workspace">
    ${flash(req)}
    <a class="services-back" href="/admin/ui/services">‹ All services</a>
    ${hero}
    <nav class="workspace-tabs" aria-label="Service settings">${tabLinks}</nav>
    ${tabBody}
  </div>`;
  return renderLayout({
    page: "services",
    title: service.name,
    body,
    walletShort,
    contentClass: "content--services",
  });
}
