import type { ServiceManifest } from "../../core/serviceRegistry/types.js";
import { defineSkills } from "../../core/serviceRegistry/types.js";
import {
  DUMMY_PRICE_ATOMIC,
  DUMMY_SKILL_ID,
  DUMMY_SLUG,
} from "./config.js";
import { dummySkillContracts } from "./skillContracts.js";

export const manifest: ServiceManifest = {
  slug: DUMMY_SLUG,
  version: "1",
  name: "Dummy Echo",
  description:
    "A deliberately simple paid Testnet example that returns the submitted message.",
  categoryFamily: "other",
  serviceType: "other",
  jurisdictions: ["global"],
  turnaroundEstimate: "< 5 seconds",
  tags: ["example", "testnet-only"],
};

export const skills = defineSkills([{
  id: DUMMY_SKILL_ID,
  name: "Echo",
  description:
    "Returns a message as a terminal artifact. This fixed-price, synchronous skill " +
    "demonstrates the complete Daski gateway-to-provider transaction path.",
  examples: [
    "Echo 'hello daski'",
    "Run a Testnet connectivity check",
  ],
  fixedPriceAtomic: DUMMY_PRICE_ATOMIC,
  requiredFields: ["message"],
  tags: ["example", "synchronous"],
}], dummySkillContracts);
