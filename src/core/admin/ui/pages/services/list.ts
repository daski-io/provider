import { listAllServices } from "../../../../db/queries/services.js";
import {
  escapeAttr,
  escapeHtml,
  renderLayout,
} from "../../layouts.js";
import {
  activePill,
  loadServiceKpis,
  onChainDisplay,
} from "./shared.js";

export async function renderServicesList(
  walletShort: string | undefined,
): Promise<string> {
  const services = await listAllServices();
  const kpis = await Promise.all(
    services.map(async (service) => ({
      service,
      kpi: await loadServiceKpis(service.id),
    })),
  );
  const activeAssets = kpis.reduce((total, item) => total + item.kpi.activeAssets, 0);

  const heading = `
    <header class="services-heading">
      <div class="mono-caption">${services.length} services · ${activeAssets} active assets</div>
      <h1>Services</h1>
    </header>`;

  const table = services.length === 0
    ? `<div class="card services-empty"><p class="dim">No services registered yet.</p></div>`
    : `<div class="card services-table-card">
        <div class="table-scroll">
          <table class="services-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Status</th>
                <th>Supplier</th>
                <th class="number-cell">Assets</th>
                <th class="number-cell">Tx 7 / 30d</th>
                <th aria-label="Open"></th>
              </tr>
            </thead>
            <tbody>${kpis.map(({ service, kpi }) => {
              const href = `/admin/ui/services/${encodeURIComponent(service.id)}`;
              return `
                <tr class="row-link" data-href="${escapeAttr(href)}">
                  <td>
                    <a class="service-row-title" href="${escapeAttr(href)}">${escapeHtml(service.name)}</a>
                    <div class="service-row-meta mono">
                      ${escapeHtml(service.slug)} v${escapeHtml(service.version)} · ${onChainDisplay(service)}
                    </div>
                  </td>
                  <td>${activePill(service.is_active)}</td>
                  <td class="mono">${escapeHtml(service.supplier ?? "—")}</td>
                  <td class="mono number-cell">${kpi.activeAssets}</td>
                  <td class="mono number-cell">${kpi.transactions7d} <span class="dim">/ ${kpi.transactions30d}</span></td>
                  <td class="row-chev" aria-hidden="true">›</td>
                </tr>`;
            }).join("")}</tbody>
          </table>
        </div>
      </div>
      <p class="services-hint mono dim">Select a service to manage skills, pricing, supplier, policy and rules.</p>`;

  return renderLayout({
    page: "services",
    title: "Services",
    body: `<div class="services-page">${heading}${table}</div>`,
    walletShort,
    contentClass: "content--services",
  });
}
