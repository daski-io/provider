// Compare this process's clock against the database server's clock.
// WSL2 guests drift after host sleep; a database ahead/behind the app
// clock breaks available_at/lease comparisons in ways CI never sees.
import { Client } from "pg";

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query("SELECT now() AS db_now");
const dbNow = new Date(rows[0].db_now).getTime();
const appNow = Date.now();
console.log("app clock:", new Date(appNow).toISOString());
console.log("db clock: ", new Date(dbNow).toISOString());
console.log("skew (app - db) ms:", appNow - dbNow);
await client.end();
