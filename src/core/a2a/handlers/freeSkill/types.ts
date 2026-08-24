export interface DaskiMetadata {
  skillId?: string;
}

export interface FreeSkillError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}
