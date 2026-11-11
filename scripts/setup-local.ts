import "dotenv/config";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
if (!process.env.SEED_PASSWORD)
  appendFileSync(
    ".env",
    `\nSEED_PASSWORD=${randomBytes(24).toString("base64url")}\n`,
  );
const url = new URL(process.env.DATABASE_URL!);
const database = url.pathname.slice(1);
if (database !== "taskflow")
  throw new Error("Local setup only provisions the taskflow database.");
url.pathname = "/postgres";
url.search = "";
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
for (const name of ["taskflow", "taskflow_test"]) {
  const exists = await client.query(
    "SELECT 1 FROM pg_database WHERE datname=$1",
    [name],
  );
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${name}"`);
}
await client.end();
console.log("Local development and test databases are ready.");
