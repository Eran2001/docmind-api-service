import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { join } from "node:path";
import { Client, Pool } from "pg";

declare module "vitest" {
  export interface ProvidedContext {
    /** False when no Postgres is reachable: database specs skip themselves instead of failing. */
    dbReady: boolean;
  }
}

// Runs once before the tests. Makes sure the `docmind_test` database exists and has every migration applied,
// so specs that need real SQL (ownership filters, search, cascades) can run against it. Your dev data is never touched.
// (Typed structurally: vitest/node is ESM-only and this project compiles to CommonJS.)
interface SetupProject {
  provide(key: "dbReady", value: boolean): void;
  config: { env?: Record<string, string | undefined> };
}

export default async function setup(project: SetupProject) {
  // `test.env` from vitest.config.mts is not in process.env yet at this point, so read it from the project config.
  const testUrl = new URL(
    project.config.env?.DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  );
  const testDb = testUrl.pathname.slice(1);
  if (!testDb.endsWith("_test")) {
    throw new Error(
      `Refusing to run database tests against "${testDb}": the database name must end in _test.`,
    );
  }

  try {
    const adminUrl = new URL(testUrl);
    adminUrl.pathname = "/postgres";
    const admin = new Client({
      connectionString: adminUrl.toString(),
      connectionTimeoutMillis: 2000,
    });
    await admin.connect();
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [testDb],
    );
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${testDb}"`);
    await admin.end();

    const pool = new Pool({ connectionString: testUrl.toString() });
    await migrate(drizzle(pool), {
      migrationsFolder: join(process.cwd(), "src/database/migrations"),
    });
    await pool.end();
    project.provide("dbReady", true);
  } catch (err) {
    console.warn(
      `\n[tests] Postgres not available (${(err as Error).message}); database specs will be skipped. Run: npm run infra:up\n`,
    );
    project.provide("dbReady", false);
  }
}
