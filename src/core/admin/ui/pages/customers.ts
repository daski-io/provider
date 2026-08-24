import type { Request, Response, Router } from "express";
import {
  getCustomerById,
  listCustomersForAdmin,
} from "../../../db/queries/customers.js";
import { listTransactionsForAdmin } from "../../../db/queries/transactions.js";
import { escapeAttr, escapeHtml, parseListLimit, pill, renderLayout } from "../layouts.js";
import { walletShortFromReq } from "../util.js";

export function mountCustomersPages(router: Router): void {
  router.get("/customers", async (req: Request, res: Response) => {
    const limit = parseListLimit(req.query as Record<string, string | undefined>);
    const rows = await listCustomersForAdmin(limit);
    const table = rows.map((row) => `<tr>
      <td><a href="/admin/ui/customers/${escapeAttr(row.id)}">${escapeHtml(row.wallet_address)}</a></td>
      <td>${escapeHtml(row.last_known_email ?? "—")}</td><td>${row.transaction_count}</td>
      <td>${row.open_review_count ? pill(String(row.open_review_count), "warning") : "0"}</td>
      <td>${escapeHtml(row.last_seen_at.toISOString())}</td>
    </tr>`).join("");
    const body = `<div class="card"><table><thead><tr><th>Wallet</th><th>Contact</th><th>Transactions</th><th>Open reviews</th><th>Last seen</th></tr></thead><tbody>${table || `<tr><td colspan="5">No customers.</td></tr>`}</tbody></table></div>`;
    res.type("html").send(renderLayout({ page: "customers", title: "Customers", body, walletShort: walletShortFromReq(req) }));
  });

  router.get("/customers/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const [customer, transactions] = await Promise.all([
      getCustomerById(id),
      listTransactionsForAdmin({ customerId: id, limit: 250 }),
    ]);
    if (!customer) { res.status(404).type("html").send("Customer not found"); return; }
    const rows = transactions.map((row) => `<tr><td>${escapeHtml(row.created_at.toISOString())}</td><td><a href="/admin/ui/transactions/${escapeAttr(row.id)}">${escapeHtml(row.id)}</a></td><td>${escapeHtml(row.service_slug)} / ${escapeHtml(row.skill_id)}</td><td>${pill(row.status, row.status === "completed" ? "success" : "info")}</td></tr>`).join("");
    const body = `<div class="card"><dl><dt>Wallet</dt><dd class="mono">${escapeHtml(customer.wallet_address)}</dd><dt>Contact</dt><dd>${escapeHtml(customer.last_known_email ?? "—")}</dd><dt>First seen</dt><dd>${escapeHtml(customer.first_seen_at.toISOString())}</dd><dt>Last seen</dt><dd>${escapeHtml(customer.last_seen_at.toISOString())}</dd></dl></div>
      <div class="card"><h2>Transactions</h2><table><tbody>${rows || `<tr><td>No transactions.</td></tr>`}</tbody></table></div>`;
    res.type("html").send(renderLayout({ page: "customers", title: "Customer", body, walletShort: walletShortFromReq(req) }));
  });
}
