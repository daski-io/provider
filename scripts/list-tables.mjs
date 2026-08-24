import pg from "pg";
const c = new pg.Client({ connectionString: process.argv[2] });
await c.connect();
const r = await c.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name",
  ["public"],
);
console.log(JSON.stringify(r.rows.map((x) => x.table_name)));
await c.end();
