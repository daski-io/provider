import type { Request, Response, Router } from "express";
import {
  countTransactions,
  getTransactionById,
  isTransactionStatus,
  listTransactionsForAdmin,
} from "../../../db/queries/transactions.js";
import { listEscalationsForTransaction } from "../../../db/queries/escalations.js";
import {
  escapeAttr,
  escapeHtml,
  escalationTone,
  parseListLimit,
  pill,
  renderLayout,
  renderLoadMore,
} from "../layouts.js";
import { walletShortFromReq } from "../util.js";

function filters(req: Request) {
  const query = req.query as Record<string, string | undefined>;
  return {
    status: query.status && isTransactionStatus(query.status) ? query.status : undefined,
    limit: parseListLimit(query),
  };
}

export function mountTransactionsPages(router: Router): void {
  router.get("/transactions", async (req: Request, res: Response) => {
    const filter = filters(req);
    const [rows, total] = await Promise.all([
      listTransactionsForAdmin(filter),
      countTransactions({ status: filter.status }),
    ]);
    const table = rows.map((row) => `<tr>
      <td>${escapeHtml(row.created_at.toISOString())}</td>
      <td><a href="/admin/ui/transactions/${escapeAttr(row.id)}">${escapeHtml(row.id)}</a></td>
      <td>${escapeHtml(row.service_slug)} / ${escapeHtml(row.skill_id)}</td>
      <td>${row.customer_wallet ? `<a href="/admin/ui/customers/${escapeAttr(row.customer_id)}">${escapeHtml(row.customer_wallet)}</a>` : "anonymous"}</td>
      <td>${pill(row.status, row.status === "completed" ? "success" : row.status === "failed" || row.status === "canceled" ? "danger" : "info")}</td>
    </tr>`).join("");
    const query = req.query as Record<string, string | undefined>;
    const body = `<form method="GET" class="row"><select name="status">
      <option value="">Any status</option>
      ${["submitted","working","input-required","completed","failed","canceled"].map((value) => `<option${filter.status === value ? " selected" : ""}>${value}</option>`).join("")}
      </select><button class="btn" type="submit">Filter</button></form>
      <div class="card"><table><thead><tr><th>Created</th><th>ID</th><th>Service / skill</th><th>Customer</th><th>Status</th></tr></thead>
      <tbody>${table || `<tr><td colspan="5">No transactions.</td></tr>`}</tbody></table>
      ${renderLoadMore({ currentLimit: filter.limit, rowsReturned: rows.length, total, query, basePath: "/admin/ui/transactions", totalLabel: "transactions" })}</div>`;
    res.type("html").send(renderLayout({ page: "transactions", title: "Transactions", body, walletShort: walletShortFromReq(req) }));
  });

  router.get("/transactions/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const [row, reviews] = await Promise.all([
      getTransactionById(id),
      listEscalationsForTransaction(id),
    ]);
    if (!row) { res.status(404).type("html").send("Transaction not found"); return; }
    const reviewRows = reviews.map((review) => `<tr><td>${pill(review.status, escalationTone(review.status))}</td><td>${escapeHtml(review.question)}</td><td><a href="/admin/ui/reviews/${escapeAttr(review.id)}">Open</a></td></tr>`).join("");
    const body = `<div class="card"><dl>
      <dt>ID</dt><dd class="mono">${escapeHtml(row.id)}</dd>
      <dt>Status</dt><dd>${pill(row.status, row.status === "completed" ? "success" : "info")}</dd>
      <dt>Service / skill</dt><dd>${escapeHtml(row.service_id)} / ${escapeHtml(row.skill_id)}</dd>
      <dt>Customer</dt><dd>${row.customer_id ? `<a href="/admin/ui/customers/${escapeAttr(row.customer_id)}">${escapeHtml(row.customer_id)}</a>` : "anonymous"}</dd>
      <dt>Order</dt><dd class="mono">${escapeHtml(row.standard_order_id ?? "—")}</dd>
      <dt>Created</dt><dd>${escapeHtml(row.created_at.toISOString())}</dd>
      </dl></div><div class="card"><h2>Reviews</h2><table><tbody>${reviewRows || `<tr><td>No reviews.</td></tr>`}</tbody></table></div>`;
    res.type("html").send(renderLayout({ page: "transactions", title: "Transaction", body, walletShort: walletShortFromReq(req) }));
  });
}
