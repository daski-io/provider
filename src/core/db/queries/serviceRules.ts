import { pool } from "../pool.js";
import { inTransaction } from "../queryable.js";
import { recordMandatoryAudit } from "../../events/emitter.js";

// Operator-curated text rules injected into LLM prompts. Per-service,
// optionally per-skill, with a scope discriminator. Only authenticated
// human operator surfaces write to this table — the Email Agent has no
// rule-writing authority (avoids the prompt-injection-installs-rule attack
// path).
//
// At LLM call time, callers fetch active rules filtered by scope +
// service_id + (optional) skill_id and inline them into the prompt as a
// numbered list. The LLM decides which rules apply.

export type RuleScope = "all" | "email_agent" | "pre_execute";

export interface ServiceRuleRow {
  id: string;
  service_id: string;
  skill_id: string | null;
  scope: RuleScope;
  rule: string;
  created_by: string;
  created_at: Date;
  active: boolean;
}

export async function createServiceRule(args: {
  service_id: string;
  skill_id?: string | null;
  scope?: RuleScope;
  rule: string;
  created_by: string;
}): Promise<ServiceRuleRow> {
  return inTransaction(pool, async (db) => {
    const result = await db.query(
      `INSERT INTO service_rules (service_id, skill_id, scope, rule, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        args.service_id,
        args.skill_id ?? null,
        args.scope ?? "all",
        args.rule,
        args.created_by,
      ],
    );
    const row = result.rows[0] as ServiceRuleRow;
    await recordMandatoryAudit(db, {
      source: "admin",
      serviceId: row.service_id,
      type: "admin.service_rule.created",
      actor: args.created_by,
      message: `Service rule '${row.id}' created.`,
      payload: {
        ruleId: row.id,
        skillId: row.skill_id,
        scope: row.scope,
      },
    });
    return row;
  });
}

export async function deactivateServiceRule(
  id: string,
  actor: string,
): Promise<ServiceRuleRow | null> {
  return inTransaction(pool, async (db) => {
    const result = await db.query(
      `UPDATE service_rules
          SET active = false
        WHERE id = $1 AND active = true
        RETURNING *`,
      [id],
    );
    const row = result.rows[0] as ServiceRuleRow | undefined;
    if (!row) return null;
    await recordMandatoryAudit(db, {
      source: "admin",
      serviceId: row.service_id,
      type: "admin.service_rule.deactivated",
      actor,
      message: `Service rule '${row.id}' deactivated.`,
      payload: {
        ruleId: row.id,
        skillId: row.skill_id,
        scope: row.scope,
      },
    });
    return row;
  });
}

/// Fetch the active ruleset for an LLM call. Pass `scope` to limit to
/// agent-specific rules; rules with `scope='all'` are always included.
/// Pass `skillId` to include skill-specific rules; rules with NULL skill
/// are always included (service-wide).
export async function listActiveRulesForLlm(args: {
  service_id: string;
  scope: Exclude<RuleScope, "all">;
  skill_id?: string;
}): Promise<ServiceRuleRow[]> {
  const params: unknown[] = [args.service_id, args.scope];
  let skillClause = "AND (skill_id IS NULL";
  if (args.skill_id !== undefined) {
    params.push(args.skill_id);
    skillClause += ` OR skill_id = $${params.length}`;
  }
  skillClause += ")";
  const result = await pool.query(
    `SELECT * FROM service_rules
      WHERE service_id = $1
        AND active = true
        AND (scope = 'all' OR scope = $2)
        ${skillClause}
      ORDER BY created_at`,
    params,
  );
  return result.rows as ServiceRuleRow[];
}

export async function listServiceRules(args: {
  service_id: string;
  active_only?: boolean;
}): Promise<ServiceRuleRow[]> {
  const params: unknown[] = [args.service_id];
  let activeClause = "";
  if (args.active_only !== false) {
    activeClause = " AND active = true";
  }
  const result = await pool.query(
    `SELECT * FROM service_rules
      WHERE service_id = $1${activeClause}
      ORDER BY created_at DESC`,
    params,
  );
  return result.rows as ServiceRuleRow[];
}
