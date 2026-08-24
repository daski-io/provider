import type { Request, Response, Router } from "express";
import {
  countEvents,
  listEvents,
  type EventSource,
  type EventSeverity,
} from "../../../events/emitter.js";
import { listAllServices } from "../../../db/queries/services.js";
import {
  escapeAttr,
  escapeHtml,
  parseListLimit,
  renderLayout,
  renderLoadMore,
} from "../layouts.js";
import {
  renderEventsList,
} from "../eventsView.js";

const SOURCES: EventSource[] = ["adapter", "email", "llm", "chain", "admin", "push", "system"];
const SEVERITIES: EventSeverity[] = ["debug", "info", "warn", "error"];

export async function renderLogPage(
  req: Request,
  walletShort: string | undefined,
): Promise<string> {
  const q = req.query as Record<string, string | undefined>;
  const limit = parseListLimit(q);
  const filter: {
    source?: EventSource;
    severity?: EventSeverity;
    serviceId?: string;
    transactionId?: string;
    type?: string;
    search?: string;
    limit: number;
  } = { limit };
  if (q.source && (SOURCES as string[]).includes(q.source)) filter.source = q.source as EventSource;
  if (q.severity && (SEVERITIES as string[]).includes(q.severity)) filter.severity = q.severity as EventSeverity;
  if (q.service) filter.serviceId = q.service;
  if (q.tx) filter.transactionId = q.tx;
  if (q.type) filter.type = q.type;
  if (q.q) filter.search = q.q;

  const [services, events, total] = await Promise.all([
    listAllServices(),
    listEvents(filter),
    countEvents(filter),
  ]);
  const serviceLite = services.map((s) => ({ id: s.id, slug: s.slug }));

  const filterControls = `
    <form method="GET" action="/admin/ui/log" class="filter-form">
      <input class="input filter-form__grow" name="q" value="${escapeAttr(q.q ?? "")}" placeholder="Filter by message, tx, actor…">
      <select name="source">
        <option value="">All sources</option>
        ${SOURCES.map((s) => `<option value="${escapeAttr(s)}"${filter.source === s ? " selected" : ""}>${escapeHtml(s)}</option>`).join("")}
      </select>
      <select name="severity">
        <option value="">Any severity</option>
        ${SEVERITIES.map((s) => `<option value="${escapeAttr(s)}"${filter.severity === s ? " selected" : ""}>${escapeHtml(s)}</option>`).join("")}
      </select>
      <select name="service">
        <option value="">All services</option>
        ${services.map((s) => `<option value="${escapeAttr(s.id)}"${filter.serviceId === s.id ? " selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
      </select>
      <input class="input" name="type" value="${escapeAttr(q.type ?? "")}" placeholder="type contains (exact)">
      <button type="submit" class="btn">Filter</button>
      <a class="btn" href="/admin/ui/log">Reset</a>
    </form>
  `;

  const loadMore = renderLoadMore({
    currentLimit: limit,
    rowsReturned: events.length,
    total,
    totalLabel: "events",
    query: req.query as Record<string, string | undefined>,
    basePath: "/admin/ui/log",
  });

  const body = `
    <link rel="stylesheet" href="/admin/ui/static/events.css">
    <div class="card" style="padding:14px;">${filterControls}</div>
    <div class="card" style="padding:0; overflow:hidden;">
      ${events.length === 0
        ? `<p class="dim" style="padding:18px;">No events match the current filters.</p>`
        : `${renderEventsList(events, serviceLite)}${loadMore}`}
    </div>
    <script src="/admin/ui/static/events.js" defer></script>
  `;
  return renderLayout({ page: "log", title: "Platform log", body, walletShort });
}

export function mountLogPage(router: Router): void {
  router.get("/log", async (req: Request, res: Response) => {
    const wallet = (req as Request & { _adminWallet?: string })._adminWallet;
    const walletShort = wallet ? wallet.slice(0, 6) + "…" + wallet.slice(-4) : undefined;
    const html = await renderLogPage(req, walletShort);
    res.type("html").send(html);
  });
}
