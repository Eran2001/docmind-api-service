import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { join } from "node:path";
import { Pool } from "pg";

// Applies every migration in src/database/migrations to DATABASE_URL, using only production dependencies (drizzle-kit, which
// `npm run db:migrate` needs, is a dev tool). The production image runs this once before the API and worker start.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: join(process.cwd(), "src/database/migrations"),
    });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
