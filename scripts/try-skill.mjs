import { randomUUID } from "node:crypto";
import { dummyService } from "../src/services/dummy/index.ts";

const usage =
  "usage: npm run try-skill -- dummy <skill-id> '<json-object>'";

const [serviceSlug, skillId, rawInput] = process.argv.slice(2);
if (!serviceSlug || !skillId || !rawInput) {
  throw new Error(usage);
}

if (serviceSlug !== "dummy") {
  throw new Error(
    "Offline execution is restricted to the bundled dummy service. " +
      "Use co-located tests for real services so supplier mutations never " +
      "bypass gateway admission or payment.",
  );
}
const service = dummyService;
const skill = service.skills.find((candidate) => candidate.id === skillId);
if (!skill) {
  throw new Error(`Unknown skill '${skillId}' for service '${serviceSlug}'`);
}

let input;
try {
  input = JSON.parse(rawInput);
} catch {
  throw new Error("skill input must be valid JSON");
}
if (!input || typeof input !== "object" || Array.isArray(input)) {
  throw new Error("skill input must be a JSON object");
}

const quote = await service.fulfillment.adapter.quote(skillId, input);
const skillDoc = service.protocol.docs.skills[skillId];
if (!quote.ok) {
  process.stdout.write(JSON.stringify({
    mode: "offline-dummy-only",
    service: serviceSlug,
    skill: skillId,
    quote,
    documentation: skillDoc,
  }, bigintReplacer, 2) + "\n");
  process.exitCode = 2;
} else {
  const result = await service.fulfillment.adapter.execute(
    skillId,
    {
      id: randomUUID(),
      service_id: "offline-dummy-service",
      skill_id: skillId,
      status: "working",
    },
    input,
  );
  process.stdout.write(JSON.stringify({
    mode: "offline-dummy-only",
    warning:
      "No gateway admission, payment, database, supplier, or chain call occurred.",
    service: serviceSlug,
    skill: skillId,
    quote,
    result,
    documentation: skillDoc,
  }, bigintReplacer, 2) + "\n");
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
