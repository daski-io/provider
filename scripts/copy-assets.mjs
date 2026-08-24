import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Copy runtime assets into dist after tsc. Generic by design: every
// service folder's `docs/` and `content/` ships automatically, so adding
// or removing a service never touches the build script. `.ts` files are
// skipped (tsc emits their compiled form separately).

const copies = [
  ["src/core/db/migrations", "dist/core/db/migrations"],
  ["src/core/admin/ui/static", "dist/core/admin/ui/static"],
];

for (const entry of readdirSync("src/services", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const dir of ["docs", "content"]) {
    copies.push([
      join("src/services", entry.name, dir),
      join("dist/services", entry.name, dir),
    ]);
  }
}

for (const [from, to] of copies) {
  if (!existsSync(from)) continue;
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !source.endsWith(".ts"),
  });
}
