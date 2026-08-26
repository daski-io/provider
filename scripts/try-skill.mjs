import { DummyAdapter } from "../src/services/dummy/adapter.ts";

const [service = "dummy", skill = "echo", ...words] = process.argv.slice(2);
if (service !== "dummy" || skill !== "echo") {
  process.stderr.write(
    "try-skill is intentionally limited to: npm run try-skill -- dummy echo [message]\n",
  );
  process.exit(1);
}
const result = await new DummyAdapter().execute({
  taskId: "offline-demo",
  orderId: "offline-demo",
  payer: "0x0000000000000000000000000000000000000001",
  serviceSlug: "dummy",
  skillId: "echo",
  signal: new AbortController().signal,
}, { message: words.join(" ") || "hello daski" });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
