import { Global, Inject, Logger, Module, type OnModuleDestroy } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { describeError } from "../common/utils/describe-error";
import { APP_CONFIG } from "../config/config.module";
import type { Env } from "../config/env.schema";
import * as schema from "./schema";

export const PG_POOL = Symbol("PG_POOL");
export const DB = Symbol("DB");

export type Database = NodePgDatabase<typeof schema>;

/** `constructor(@Inject(DB) private readonly db: Database)`: all SQL lives in repositories. */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: Env): Pool => {
        const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
        // An idle client can error (e.g. Postgres restarts). Without a listener that would crash the process.
        pool.on("error", (err) => new Logger("Postgres").error(`Idle client error: ${describeError(err)}`));
        return pool;
      },
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
  ],
  exports: [PG_POOL, DB],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
