import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { migrations } from "./migrations.js";
const { Pool, types } = pg;
types.setTypeParser(20, (v) => Number(v));
export const db = new Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, application_name: "esqueletops-nova" });
db.on("error", (error) => logger.error({ error }, "Erro inesperado no PostgreSQL"));
export async function connectDatabase() {
  const client = await db.connect();
  try {
    await client.query("SELECT 1");
    await client.query("SELECT pg_advisory_lock(hashtext('esqueletops_nova_migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    for (const migration of migrations) {
      if ((await client.query("SELECT 1 FROM schema_migrations WHERE id=$1", [migration.id])).rowCount) continue;
      await client.query("BEGIN");
      try { await client.query(migration.sql); await client.query("INSERT INTO schema_migrations(id) VALUES($1)", [migration.id]); await client.query("COMMIT"); }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtext('esqueletops_nova_migrations'))"); } catch {}
    client.release();
  }
  logger.info("PostgreSQL conectado e migrado");
}
export async function closeDatabase() { await db.end(); }
