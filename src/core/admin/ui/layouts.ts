// HTML rendering helpers for the admin UI. Dark-theme by default, with Inter
// sans, JetBrains Mono for chain data, and mint/apricot accents. No template
// engine — just template literals and escape helpers.

export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s: unknown): string {
  return escapeHtml(s);
}

export function mono(s: unknown): string {
  return `<span class="mono">${escapeHtml(s)}</span>`;
}

export function pill(label: string, tone: "neutral" | "success" | "warning" | "danger" | "info" = "neutral"): string {
  return `<span class="pill pill--${tone}">${escapeHtml(label)}</span>`;
}

/// Pill tone for an escalation status — shared by the dashboard,
/// transaction detail, and Operator chat renderings.
export function escalationTone(
  status: string,
): "warning" | "info" | "success" | "danger" | "neutral" {
  if (status === "pending" || status === "awaiting_human") return "warning";
  if (status === "in_agent_review") return "info";
  if (status === "rejected") return "danger";
  if (status === "resolved" || status === "approved" || status === "edited") return "success";
  return "neutral";
}

// Default page size for the Transactions/Buyers/Platform-log lists. The
// "Load more" button grows the limit by this amount each click. Kept
// here so the three pages stay in lockstep — a single tweak adjusts all
// three.
export const LIST_PAGE_SIZE = 50;

/// Parse ?limit= for the list pages: default LIST_PAGE_SIZE, capped at
/// 1000 to prevent runaway URLs — anyone going past that should filter.
export function parseListLimit(query: Record<string, string | undefined>): number {
  const raw = query.limit;
  const n = raw ? parseInt(raw, 10) : LIST_PAGE_SIZE;
  if (!Number.isFinite(n) || n <= 0) return LIST_PAGE_SIZE;
  return Math.min(n, 1000);
}

/// Render the "showing N of TOTAL · Load more" footer used at the bottom
/// of every list card (Transactions, Buyers, Platform log, buyer detail
/// tx-table). When `total > rowsReturned`, a button bumps `limit` by
/// LIST_PAGE_SIZE while preserving every other query parameter. When
/// `total === rowsReturned`, the button is dropped and only the count
/// label shows. Mirrors the design's DataTable footer.
export function renderLoadMore(args: {
  currentLimit: number;
  rowsReturned: number;
  total: number;
  totalLabel?: string;
  query: Record<string, string | undefined> | URLSearchParams;
  basePath: string;
}): string {
  const params = args.query instanceof URLSearchParams
    ? new URLSearchParams(args.query)
    : new URLSearchParams();
  if (!(args.query instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(args.query)) {
      if (v !== undefined && k !== "limit") params.set(k, v);
    }
  } else {
    params.delete("limit");
  }
  const newLimit = args.currentLimit + LIST_PAGE_SIZE;
  params.set("limit", String(newLimit));
  const href = `${args.basePath}?${params.toString()}`;
  const noun = args.totalLabel ?? "rows";
  const status = `showing ${args.rowsReturned} of ${args.total} ${noun}`;
  if (args.rowsReturned >= args.total) {
    return `<div class="list-actions"><span class="dim">${escapeHtml(status)}</span></div>`;
  }
  return `<div class="list-actions">
    <span class="dim" style="margin-right:10px;">${escapeHtml(status)}</span>
    <a class="btn" href="${escapeAttr(href)}">Load more</a>
  </div>`;
}

const NAV_ITEMS: Array<{ id: string; label: string; href: string }> = [
  { id: "chat", label: "Operator", href: "/admin/ui/chat" },
  { id: "services", label: "Services", href: "/admin/ui/services" },
  { id: "transactions", label: "Transactions", href: "/admin/ui/transactions" },
  { id: "customers", label: "Customers", href: "/admin/ui/customers" },
  { id: "reviews", label: "Reviews", href: "/admin/ui/reviews" },
  { id: "emails", label: "Email", href: "/admin/ui/emails" },
  { id: "log", label: "Platform log", href: "/admin/ui/log" },
];


export function renderLayout(args: {
  page: string;
  title: string;
  body: string;
  walletShort?: string;
  contentClass?: string;
}): string {
  const navHtml = NAV_ITEMS.map((item) => {
    const active = item.id === args.page ? "active" : "";
    const marker = item.id === "reviews" ? " data-review-nav" : "";
    return `<a class="${active}" href="${escapeAttr(item.href)}"${marker}>${escapeHtml(item.label)}</a>`;
  }).join("");

  const walletFooter = args.walletShort
    ? `<div class="sidebar-account" style="margin-top:auto; padding:14px; border-top:1px solid var(--pro-border);">
         <div class="mono-caption">Provider</div>
         <div class="mono" style="font-size:11.5px; color:var(--mint-400); margin-top:6px;">
           ${escapeHtml(args.walletShort)}
         </div>
         <div style="margin-top:8px;">
           <a class="dim" style="font-size:12px;" href="/admin/ui/logout">Sign out</a>
         </div>
       </div>`
    : "";

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(args.title)} · daski provider admin</title>
  <link rel="stylesheet" href="/admin/ui/static/admin.css">
  ${args.contentClass
    ? `<link rel="stylesheet" href="/admin/ui/static/services.css">
  <link rel="stylesheet" href="/admin/ui/static/service-workspace.css">
  <link rel="stylesheet" href="/admin/ui/static/service-controls.css">`
    : ""}
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <span>daski</span>
        <span class="tag">provider</span>
      </div>
      <nav class="nav">${navHtml}</nav>
      ${walletFooter}
    </aside>
    <main class="main">
      <div class="topbar"><h1>${escapeHtml(args.title)}</h1></div>
      <div class="content${args.contentClass ? ` ${escapeAttr(args.contentClass)}` : ""}">${args.body}</div>
    </main>
  </div>
  <script src="/admin/ui/static/admin.js" defer></script>
</body>
</html>`;
}

export function renderLogin(error?: string): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <title>Sign in · daski provider admin</title>
  <link rel="stylesheet" href="/admin/ui/static/admin.css">
  <link rel="stylesheet" href="/admin/ui/static/login.css">
</head>
<body>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-brand">
        <span>daski</span>
        <span class="tag">provider</span>
      </div>
      <h2>Sign in</h2>
      <p>Connect your wallet, sign the SIWE message, and you're in. Only wallets on the operator allowlist can sign in.</p>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <button id="connect" class="btn btn--primary" style="width:100%;">Connect wallet &amp; sign in</button>
      <div id="status"></div>
    </div>
  </div>
  <script src="/admin/ui/static/login.js" defer></script>
</body>
</html>`;
}
