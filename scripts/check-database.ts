import "dotenv/config";
import pg from "pg";
import { TLSSocket } from "node:tls";
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 12000,
});
try {
  await client.connect();
  const result = await client.query(
    'SELECT current_database() AS database, current_user AS role, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS "poolerToDatabaseTls"',
  );
  const schema =
    new URL(process.env.DATABASE_URL!).searchParams.get("schema") || "public";
  const tables = await client.query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('User','Session','Workspace','Project','Task')",
    [schema],
  );
  console.log(
    JSON.stringify({
      connected: true,
      ...result.rows[0],
      clientTlsVerified:
        client.connection.stream instanceof TLSSocket &&
        client.connection.stream.authorized,
      schema,
      taskflowCoreTables: tables.rows[0].count,
    }),
  );
  if (new URL(process.env.DATABASE_URL!).hostname.endsWith(".supabase.com")) {
    const permissions = await client.query(
      "SELECT has_schema_privilege('anon',$1,'USAGE') AS anonymous_access, has_schema_privilege('authenticated',$1,'USAGE') AS authenticated_api_access",
      [schema],
    );
    console.log(JSON.stringify({ schemaAccess: permissions.rows[0] }));
  }
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
