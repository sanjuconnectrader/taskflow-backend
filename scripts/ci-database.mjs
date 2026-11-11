import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
if (!process.env.GITHUB_ACTIONS || !process.env.GITHUB_ENV)
  throw Error("This helper is for disposable GitHub-hosted CI runners only.");
const password = randomBytes(32).toString("base64url");
console.log(`::add-mask::${password}`);
const started = spawnSync(
  "docker",
  [
    "run",
    "--detach",
    "--name",
    "taskflow-ci-postgres",
    "-p",
    "127.0.0.1:5432:5432",
    "-e",
    "POSTGRES_PASSWORD",
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_DB=taskflow_test",
    "postgres:17",
  ],
  { env: { ...process.env, POSTGRES_PASSWORD: password }, encoding: "utf8" },
);
if (started.status !== 0)
  throw Error("Could not start disposable PostgreSQL: " + started.stderr);
for (let i = 0; i < 60; i++) {
  const ready = spawnSync(
    "docker",
    [
      "exec",
      "taskflow-ci-postgres",
      "pg_isready",
      "-U",
      "postgres",
      "-d",
      "taskflow_test",
    ],
    { encoding: "utf8" },
  );
  if (ready.status === 0) {
    appendFileSync(
      process.env.GITHUB_ENV,
      `DATABASE_URL=postgresql://postgres:${password}@localhost:5432/taskflow_test\n`,
    );
    console.log("Isolated PostgreSQL is ready.");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
throw Error("PostgreSQL did not become ready in CI.");
