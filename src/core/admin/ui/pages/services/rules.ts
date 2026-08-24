import type { ServiceRuleRow } from "../../../../db/queries/serviceRules.js";
import type { ServiceRow } from "../../../../db/queries/services.js";
import type { SkillRow } from "../../../../db/queries/skills.js";
import { escapeAttr, escapeHtml, pill } from "../../layouts.js";

export function renderRulesTab(args: {
  service: ServiceRow;
  skills: SkillRow[];
  rules: ServiceRuleRow[];
}): string {
  const { service, skills, rules } = args;
  const suggestions = skills.map(
    (skill) => `<option value="${escapeAttr(skill.skill_id)}">${escapeHtml(skill.skill_id)}</option>`,
  ).join("");
  const ruleCards = rules.length === 0
    ? `<section class="card workspace-card services-empty"><p class="dim">No rules configured for this service yet.</p></section>`
    : rules.map((rule) => `<article class="card rule-card">
        <div class="rule-meta">
          ${pill(rule.scope, "neutral")}
          ${rule.skill_id ? `<span class="mono dim">skill · ${escapeHtml(rule.skill_id)}</span>` : '<span class="mono dim">all skills</span>'}
          ${rule.active ? pill("active", "success") : pill("inactive", "neutral")}
          <span class="mono dim rule-author">by ${escapeHtml(rule.created_by)} · ${escapeHtml(rule.created_at.toISOString().slice(0, 10))}</span>
        </div>
        <p class="workspace-copy">${escapeHtml(rule.rule)}</p>
        ${rule.active
          ? `<form method="POST" action="/admin/ui/config/rules/${escapeAttr(rule.id)}/deactivate" class="rule-actions">
              <input type="hidden" name="service_id" value="${escapeAttr(service.id)}">
              <button class="btn" type="submit">Deactivate</button>
            </form>`
          : ""}
      </article>`).join("");

  return `<div class="workspace-stack">
    <section class="card workspace-card">
      <div class="workspace-card-head"><div class="mono-caption">New rule · free text</div></div>
      <form method="POST" action="/admin/ui/config/services/${escapeAttr(service.id)}/rules" class="rule-create-form">
        <label class="field-group">
          <span class="field-label">Rule text</span>
          <textarea class="input" name="rule" rows="3" placeholder='If an email mentions "GDPR data deletion", escalate to operator.' required></textarea>
        </label>
        <div class="rule-create-controls">
          <label class="field-group">
            <span class="field-label">Scope</span>
            <select name="scope" class="input">
              <option value="all">all</option>
              <option value="email_agent">email_agent</option>
              <option value="pre_execute">pre_execute</option>
            </select>
          </label>
          <label class="field-group">
            <span class="field-label">Skill (optional)</span>
            <input class="input mono" name="skill_id" list="service-skill-options" placeholder="any skill">
          </label>
          <datalist id="service-skill-options">${suggestions}</datalist>
          <button class="btn btn--primary" type="submit">Add rule</button>
        </div>
      </form>
      <p class="workspace-note"><span class="mono">email_agent</span> applies while drafting replies; <span class="mono">pre_execute</span> gates work before execution; <span class="mono">all</span> does both.</p>
    </section>
    ${ruleCards}
  </div>`;
}
