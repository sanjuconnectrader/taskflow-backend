import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "dotenv";
import pg from "pg";

// Run explicitly after entering credentials in the ignored .env.supabase file.
// Authentication is checked before any database or local configuration changes.
const cloud = parse(fs.readFileSync(".env.supabase", "utf8"));
const runtime = new URL(cloud.DATABASE_URL);
const direct = new URL(
  cloud.DIRECT_URL || cloud.DIRECT_DATABASE_URL || cloud.DATABASE_URL,
);
for (const url of [runtime, direct]) {
  if (
    !url.hostname.endsWith(".pooler.supabase.com") &&
    !url.hostname.endsWith(".supabase.co")
  )
    throw new Error("Expected a Supabase database hostname.");
  if (!url.password || url.password.includes("YOUR-PASSWORD"))
    throw new Error("Enter the database password in .env.supabase first.");
  url.searchParams.set("schema", "taskflow");
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", "certs/supabase-ca.crt");
}
if (direct.port === "6543")
  throw new Error(
    "DIRECT_URL must use the session pooler on port 5432 for migrations.",
  );
const client = new pg.Client({
  connectionString: direct.toString(),
  connectionTimeoutMillis: 12000,
});
try {
  await client.connect();
  await client.query("SELECT 1");
  console.log("Supabase authentication and verified TLS connection succeeded.");
  await client.query("CREATE SCHEMA IF NOT EXISTS taskflow");
  await client.query(
    "REVOKE ALL ON SCHEMA taskflow FROM PUBLIC, anon, authenticated",
  );
  const result = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: {
        ...process.env,
        DATABASE_URL: runtime.toString(),
        DIRECT_URL: direct.toString(),
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("Migration failed. The active local .env was not changed.");
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: runtime.toString(),
        max: 2,
        connectionTimeoutMillis: 12000,
      },
      { schema: "taskflow" },
    ),
  });
  try {
    await prisma.user.count();
    await prisma.project.count();
    await prisma.task.count();
  } finally {
    await prisma.$disconnect();
  }
  const original = fs.readFileSync(".env", "utf8");
  const local = parse(original);
  const updates: Record<string, string> = {
    DATABASE_URL: runtime.toString(),
    DIRECT_URL: direct.toString(),
  };
  for (const key of [
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_JWKS_URL",
  ])
    if (cloud[key]) updates[key] = cloud[key];
  if (!local.TEST_DATABASE_URL && local.DATABASE_URL) {
    const test = new URL(local.DATABASE_URL);
    if (["localhost", "127.0.0.1"].includes(test.hostname)) {
      test.pathname = "/taskflow_test";
      updates.TEST_DATABASE_URL = test.toString();
    }
  }
  let content = original;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content)
      ? content.replace(pattern, () => line)
      : content.trimEnd() + "\n" + line + "\n";
  }
  if (!fs.existsSync(".env.before-supabase"))
    fs.copyFileSync(".env", ".env.before-supabase");
  fs.writeFileSync(".env", content, { mode: 0o600 });
  console.log(
    "TaskFlow migrations and Prisma reads verified. Supabase is now configured in .env. Restart the backend.",
  );
} catch (error) {
  const e = error as NodeJS.ErrnoException;
  console.error(
    JSON.stringify({
      connected: false,
      code: e.code || e.name,
      message: e.message,
    }),
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
