import type { ServiceManifest } from "../../core/serviceRegistry/types.js";
import { defineSkills } from "../../core/serviceRegistry/types.js";
import { AUDIT_PRICE_ATOMIC, AUDIT_SKILL_ID, SYNTHETIC_AUDIT_SLUG } from "./config.js";
import { auditSkillContracts } from "./skillContracts.js";

export const manifest: ServiceManifest = {
  slug: SYNTHETIC_AUDIT_SLUG,
  version: "1",
  name: "Synthetic Audit",
  description:
    "A Testnet-only example of a product that runs each paid audit as its own eight-hour job.",
  categoryFamily: "other",
  serviceType: "other",
  jurisdictions: ["global"],
  turnaroundEstimate: "about 8 hours",
  tags: ["example", "testnet-only", "external-job"],
};

export const skills = defineSkills([{
  id: AUDIT_SKILL_ID,
  name: "Audit",
  description:
    "Audits a described subject and returns a short report. The fixed-price job " +
    "runs for about eight hours in the product; Daski tracks it until the report is ready.",
  examples: [
    "Audit the onboarding flow of a sample application",
  ],
  fixedPriceAtomic: AUDIT_PRICE_ATOMIC,
  requiredFields: ["description"],
  tags: ["example", "external-job"],
}], auditSkillContracts);
