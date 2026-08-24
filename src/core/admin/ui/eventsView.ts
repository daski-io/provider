import type { EventRow, EventSeverity, EventSource } from "../../events/emitter.js";
import { escapeAttr, escapeHtml, pill } from "./layouts.js";

// Shared expandable-events list used by Platform Log and the
// per-transaction Timeline. Both want identical rows (When · Source ·
// Message · Severity · chevron) with the same click-to-expand
// JSON/Fields panel; only the surrounding card chrome and filters
// differ. CSS + JS are exported so each page can splice them in once.

const SOURCE_COLORS: Record<EventSource, string> = {
  chain: "#34d3b1",
  adapter: "#f0a878",
  llm: "#c084fc",
  email: "#7fb6e6",
  admin: "#e8b658",
  push: "#6ba9e3",
  system: "#7a7a8e",
};

export function sourceDot(s: EventSource): string {
  const color = SOURCE_COLORS[s] ?? "#7a7a8e";
  return `<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${color};"></span>`;
}

function severityColor(s: EventSeverity): string {
  return s === "error"
    ? "#f4798d"
    : s === "warn"
      ? "#e8b658"
      : "var(--fg-1)";
}

function severityPill(s: EventSeverity): string {
  const tone: "danger" | "warning" | "neutral" =
    s === "error" ? "danger" : s === "warn" ? "warning" : "neutral";
  return pill(s, tone);
}

function buildEventJson(ev: EventRow): string {
  const obj: Record<string, unknown> = {
    id: ev.id,
    at: ev.created_at.toISOString(),
    source: ev.source,
    severity: ev.severity,
    type: ev.type,
    message: ev.message,
  };
  if (ev.actor !== null) obj.actor = ev.actor;
  if (ev.service_id !== null) obj.service_id = ev.service_id;
  if (ev.transaction_id !== null) obj.transaction_id = ev.transaction_id;
  if (ev.asset_id !== null) obj.asset_id = ev.asset_id;
  if (ev.payload !== null) obj.payload = ev.payload;
  return JSON.stringify(obj, null, 2);
}

function buildFieldRows(ev: EventRow): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined) {
      rows.push([path, "null"]);
      return;
    }
    if (Array.isArray(value)) {
      rows.push([path, JSON.stringify(value)]);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    rows.push([path, String(value)]);
  };
  walk(JSON.parse(buildEventJson(ev)), "");
  return rows;
}

export function renderEventRow(
  ev: EventRow,
  services: Array<{ id: string; slug: string }>,
): string {
  const dateFull = ev.created_at.toISOString().slice(0, 19).replace("T", " ");
  const sevColor = severityColor(ev.severity);
  const service = services.find((s) => s.id === ev.service_id);
  const txLink = ev.transaction_id
    ? `<a class="mono" href="/admin/ui/transactions/${escapeAttr(ev.transaction_id)}"
         style="margin-left:8px; font-size:11px; text-decoration:underline; text-decoration-color:rgba(52,211,177,0.3);">
         ${escapeHtml(ev.transaction_id.slice(0, 8))}…
       </a>`
    : "";

  const json = buildEventJson(ev);
  const fieldRows = buildFieldRows(ev);
  const fieldsHtml = fieldRows
    .map(
      ([k, v], i) => `
        <div style="display:grid; grid-template-columns:240px 1fr; gap:14px;
                    padding:8px 14px; ${i < fieldRows.length - 1 ? "border-bottom:1px solid var(--pro-border);" : ""}
                    font-size:12px;">
          <span class="mono dim" style="font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${escapeHtml(k)}
          </span>
          <span class="mono" style="color:var(--mint-400); font-size:11.5px; word-break:break-all;">
            ${escapeHtml(v)}
          </span>
        </div>`,
    )
    .join("");

  const openTxBtn = ev.transaction_id
    ? `<a class="btn" href="/admin/ui/transactions/${escapeAttr(ev.transaction_id)}"
         style="font-size:11px; padding:4px 10px;">Open transaction ↗</a>`
    : "";

  return `
    <details class="log-row" data-event-id="${escapeAttr(ev.id)}">
      <summary class="log-summary">
        <span class="mono dim log-time">${escapeHtml(dateFull)}</span>
        <span class="log-source-dot">${sourceDot(ev.source)}</span>
        <span class="log-source">
          <span class="mono" style="color:var(--mint-400); font-size:11px;">${escapeHtml(ev.source)}</span>
        </span>
        <span class="log-message">
          <span style="color:${sevColor}; font-weight:500;">${escapeHtml(ev.message)}</span>
          ${txLink}
        </span>
        <span class="log-severity">${severityPill(ev.severity)}</span>
        <span class="log-chev">›</span>
      </summary>
      <div class="log-detail">
        <div class="log-detail-bar">
          <div class="log-tabs" role="tablist">
            <button type="button" class="log-tab is-active" data-tab="json">JSON</button>
            <button type="button" class="log-tab" data-tab="fields">FIELDS</button>
          </div>
          <span class="mono dim" style="font-size:11px;">${escapeHtml(ev.type)}</span>
          ${service ? `<span class="mono dim" style="font-size:11px;">${escapeHtml(service.slug)}</span>` : ""}
          <div style="flex:1;"></div>
          ${openTxBtn}
          <button type="button" class="btn log-copy" data-json="${escapeAttr(json)}"
            style="font-size:11px; padding:4px 10px;">Copy JSON</button>
        </div>
        <pre class="log-json" data-tab-pane="json">${escapeHtml(json)}</pre>
        <div class="log-fields" data-tab-pane="fields" style="display:none;">${fieldsHtml}</div>
      </div>
    </details>
  `;
}

export function renderEventsHeader(): string {
  return `
    <div class="log-header">
      <span>When</span>
      <span></span>
      <span>Source</span>
      <span>Message</span>
      <span>Severity</span>
      <span></span>
    </div>
  `;
}

/// Render the table fragment: header row + list of expandable event
/// rows. Returns just the contents to splice inside a Card; callers
/// supply the card and any pagination footer.
export function renderEventsList(
  events: EventRow[],
  services: Array<{ id: string; slug: string }>,
): string {
  if (events.length === 0) {
    return `<p class="dim" style="padding:18px;">No events yet.</p>`;
  }
  return `${renderEventsHeader()}<div class="log-list">${events.map((e) => renderEventRow(e, services)).join("")}</div>`;
}
