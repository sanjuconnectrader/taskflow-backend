import "dotenv/config";
import { defineConfig } from "vitest/config";
const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL!);
url.pathname = "/taskflow_test";
if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
  throw new Error(
    "Integration tests only run against a local taskflow_test database.",
  );
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = "test";
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 },
});
