import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const copies = [["src/core/db/migrations", "dist/core/db/migrations"]];
for (const entry of readdirSync("src/services", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = join("src/services", entry.name, "docs");
  if (existsSync(source)) {
    copies.push([source, join("dist/services", entry.name, "docs")]);
  }
}
for (const [from, to] of copies) cpSync(from, to, { recursive: true });
