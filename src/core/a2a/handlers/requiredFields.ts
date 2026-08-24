import type { SkillRow } from "../../db/queries/skills.js";

export function missingRequiredFields(
  skill: SkillRow,
  data: Record<string, unknown>,
): string[] {
  return (skill.required_fields ?? []).filter((field) => !(field in data));
}
