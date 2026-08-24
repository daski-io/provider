import type { Request, Response, Router } from "express";
import type { ToolContext } from "../../../agents/operatorAgent/tools/shared.js";
import {
  closeEscalation,
  getEscalationById,
  getReviewQueueMetrics,
  listOpenEscalations,
} from "../../../db/queries/escalations.js";
import { pool } from "../../../db/pool.js";
import { inTransaction } from "../../../db/queryable.js";
import { recordMandatoryAudit } from "../../../events/emitter.js";
import {
  claimPreExecuteResolution,
  retryResolutionAttention,
} from "../../../engine/escalationResolutionStore.js";
import { adminActionFailure } from "../actionFailure.js";
import {
  escapeAttr,
  escapeHtml,
  escalationTone,
  pill,
  renderLayout,
} from "../layouts.js";
import { readFormBody, walletFromReq, walletShortFromReq } from "../util.js";
import { listReviewActionTools } from "../reviewActionTools.js";
import {
  mountReviewConversationRoutes,
  renderReviewConversation,
} from "../reviewConversation.js";

const protectedExecutionSources = new Set(["pre_execute", "fulfillment_hold"]);

export function mountReviewsPages(router: Router): void {
  router.get("/reviews", async (req: Request, res: Response) => {
    const [rows, metrics] = await Promise.all([
      listOpenEscalations({ limit: 500 }),
      getReviewQueueMetrics(),
    ]);
    const table = rows.map((row) => `<tr>
      <td>${pill(row.status, escalationTone(row.status))}</td>
      <td>${escapeHtml(row.severity ?? "—")}</td><td>${escapeHtml(row.source)}</td>
      <td><a href="/admin/ui/reviews/${escapeAttr(row.id)}">${escapeHtml(row.question)}</a></td>
      <td>${escapeHtml(row.created_at.toISOString())}</td>
    </tr>`).join("");
    const body = `<div class="row" style="gap:8px; margin-bottom:12px;">
      ${pill(`${metrics.open} open`, "warning")}
      ${pill(`${metrics.critical} critical`, metrics.critical ? "danger" : "neutral")}
      ${pill(`${metrics.overdue} overdue`, metrics.overdue ? "danger" : "neutral")}
    </div><div class="card"><table><thead><tr><th>Status</th><th>Severity</th><th>Source</th><th>Question</th><th>Created</th></tr></thead><tbody>${table || `<tr><td colspan="5">No open reviews.</td></tr>`}</tbody></table></div>`;
    res.type("html").send(renderLayout({ page: "reviews", title: "Reviews", body, walletShort: walletShortFromReq(req) }));
  });

  router.get("/reviews/count", async (_req: Request, res: Response) => {
    res.json(await getReviewQueueMetrics());
  });

  router.get("/reviews/:id", async (req: Request, res: Response) => {
    const row = await getEscalationById(String(req.params.id));
    if (!row) { res.status(404).type("html").send("Review not found"); return; }
    const isExecution = protectedExecutionSources.has(row.source);
    const pending = row.status === "pending" || row.status === "awaiting_human";
    const attention = row.status === "resolution_attention";
    const actionHelp = (row.available_actions ?? []).map((action) => `<li><strong>${escapeHtml(action.label)}</strong>${action.effect ? ` — ${escapeHtml(action.effect)}` : ""}</li>`).join("");
    const toolOptions = listReviewActionTools().map((tool) =>
      `<option value="${escapeAttr(tool.name)}">${escapeHtml(tool.name)} — ${escapeHtml(tool.description)}</option>`
    ).join("");
    const conversation = await renderReviewConversation(req, row.id);
    const actions = attention && isExecution
      ? `<form method="POST" action="/admin/ui/reviews/${escapeAttr(row.id)}/retry">
      <label>Retype review id to retry the durable resolution: <code>${escapeHtml(row.id)}</code></label>
      <input name="confirmation" autocomplete="off" required>
      <button class="btn btn--primary" type="submit">Retry exact resolution</button>
      <p class="workspace-note">The existing signed decision and execution journal are reused; supplier work is not started from an unbound request.</p>
    </form>`
      : (pending || attention) ? (isExecution ? `<form method="POST" action="/admin/ui/reviews/${escapeAttr(row.id)}/decision">
      <label>Operator note</label><textarea name="response" maxlength="2000"></textarea>
      <label>Edited request JSON (required only for approve with edits)</label><textarea name="editedData" maxlength="32768"></textarea>
      <button class="btn btn--primary" name="decision" value="approved" type="submit">Approve and execute</button>
      <button class="btn" name="decision" value="edited" type="submit">Approve edits and execute</button>
      <button class="btn" name="decision" value="rejected" type="submit">Reject</button>
    </form>` : `<form method="POST" action="/admin/ui/reviews/${escapeAttr(row.id)}/action">
      <label>Audited service action</label><select name="tool" required>${toolOptions}</select>
      <label>Exact action arguments (JSON object)</label><textarea name="arguments" maxlength="32768" required>{}</textarea>
      <label>Retype review id to authorize this action: <code>${escapeHtml(row.id)}</code></label>
      <input name="confirmation" autocomplete="off" required>
      <button class="btn btn--primary" type="submit">Execute exact action</button>
      <p class="workspace-note">The review closes only when the service action confirms its durable disposition.</p>
    </form>`) : `<p>${pill(row.status, escalationTone(row.status))}</p>`;
    const body = `<div class="card"><dl>
      <dt>Status</dt><dd>${pill(row.status, escalationTone(row.status))}</dd>
      <dt>Source</dt><dd>${escapeHtml(row.source)}</dd><dt>Kind</dt><dd>${escapeHtml(row.review_kind ?? "—")}</dd>
      <dt>Question</dt><dd>${escapeHtml(row.question)}</dd><dt>Why human</dt><dd>${escapeHtml(row.why_human ?? "—")}</dd>
      ${row.resolution_error ? `<dt>Resolution error</dt><dd>${escapeHtml(row.resolution_error)}</dd>` : ""}
      <dt>Transaction</dt><dd>${row.transaction_id ? `<a href="/admin/ui/transactions/${escapeAttr(row.transaction_id)}">${escapeHtml(row.transaction_id)}</a>` : "—"}</dd>
      </dl>${actionHelp ? `<h3>Runbook actions</h3><ul>${actionHelp}</ul>` : ""}${actions}</div>${conversation}`;
    res.type("html").send(renderLayout({ page: "reviews", title: "Review", body, walletShort: walletShortFromReq(req) }));
  });

  router.post("/reviews/:id/decision", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const form = await readFormBody(req);
      const decision = form.get("decision");
      const response = (form.get("response") ?? "").trim();
      const actor = walletFromReq(req);
      if (!actor) throw new Error("authenticated operator is required");
      const row = await getEscalationById(id);
      if (!row) { res.status(404).type("html").send("Review not found"); return; }
      if (protectedExecutionSources.has(row.source)) {
        if (decision !== "approved" && decision !== "edited" && decision !== "rejected") {
          res.status(400).type("html").send("Invalid protected-execution decision"); return;
        }
        const edited = form.get("editedData")?.trim();
        const editedData = decision === "edited" ? JSON.parse(edited || "") as Record<string, unknown> : undefined;
        const claimed = await claimPreExecuteResolution({ escalationId: id, decision, actor, response, editedData });
        if (!claimed.claimed) { res.status(409).type("html").send("Review was already claimed"); return; }
      } else throw new Error("Non-execution reviews require a service-specific audited action");
      res.redirect(`/admin/ui/reviews/${encodeURIComponent(id)}`);
    } catch (error) {
      res.status(400).type("html").send(adminActionFailure("review-decision", error));
    }
  });

  router.post("/reviews/:id/action", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const form = await readFormBody(req);
      const actor = walletFromReq(req);
      if (!actor) throw new Error("authenticated operator is required");
      if (form.get("confirmation") !== id) throw new Error("review id confirmation does not match");
      const row = await getEscalationById(id);
      if (!row) { res.status(404).type("html").send("Review not found"); return; }
      if (protectedExecutionSources.has(row.source)) {
        throw new Error("Protected execution reviews use the dedicated decision form");
      }
      if (row.status !== "pending" && row.status !== "awaiting_human" &&
          row.status !== "resolution_attention") {
        res.status(409).type("html").send("Review is not open for an action"); return;
      }
      const tool = listReviewActionTools().find((candidate) => candidate.name === form.get("tool"));
      if (!tool) throw new Error("unsupported review action");
      const parsed: unknown = JSON.parse(form.get("arguments") ?? "");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("action arguments must be a JSON object");
      }
      const context: ToolContext = {
        actor,
        mode: "human" as const,
        escalationId: id,
        directAdminApproval: true as const,
      };
      const result = JSON.parse(await tool.execute(parsed as Record<string, unknown>, context)) as {
        ok?: boolean;
        reason?: string;
        message?: string;
      };
      if (result.ok !== true) {
        throw new Error(result.message ?? result.reason ?? "service action was not completed");
      }
      if (context.escalationClosed) {
        await inTransaction(pool, async (db) => {
          const closed = await closeEscalation({
            id,
            status: "resolved",
            resolved_by: actor,
            response: `Resolved by approved action ${tool.name}.`,
          }, db);
          if (!closed) return;
          await recordMandatoryAudit(db, {
            transactionId: row.transaction_id ?? undefined,
            source: "admin",
            actor,
            type: "review.service_action.resolved",
            message: "An approved service action resolved its bound review.",
            payload: { escalationId: id, actionName: tool.name },
          });
        });
      }
      res.redirect(`/admin/ui/reviews/${encodeURIComponent(id)}`);
    } catch (error) {
      res.status(400).type("html").send(adminActionFailure("review-action", error));
    }
  });

  router.post("/reviews/:id/retry", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const form = await readFormBody(req);
      const actor = walletFromReq(req);
      if (!actor) throw new Error("authenticated operator is required");
      if (form.get("confirmation") !== id) throw new Error("review id confirmation does not match");
      if (!await retryResolutionAttention({ escalationId: id, actor })) {
        res.status(409).type("html").send("Review is not retryable"); return;
      }
      res.redirect(`/admin/ui/reviews/${encodeURIComponent(id)}`);
    } catch (error) {
      res.status(400).type("html").send(adminActionFailure("review-retry", error));
    }
  });

  mountReviewConversationRoutes(router);
}
