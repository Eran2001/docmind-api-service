import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Pool } from "pg";

import { PG_POOL } from "../../database/database.module";
import { AiClient } from "../../integrations/ai/ai.client";
import { REDIS } from "../../integrations/redis/redis.module";

export type ServiceState = "up" | "down";

export interface HealthReport {
  /** ok: everything up. degraded: only the AI service is down. down: the database or Redis is down. */
  status: "ok" | "degraded" | "down";
  db: ServiceState;
  redis: ServiceState;
  ai: ServiceState;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);

const probe = async (check: () => Promise<unknown>): Promise<ServiceState> => {
  try {
    await withTimeout(check(), 2000);
    return "up";
  } catch {
    return "down";
  }
};

@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly ai: AiClient,
  ) {}

  async check(): Promise<HealthReport> {
    const [db, redis, ai] = await Promise.all([
      probe(() => this.pool.query("SELECT 1")),
      probe(() => this.redis.ping()),
      this.ai.isHealthy().then((ok): ServiceState => (ok ? "up" : "down")),
    ]);
    const status =
      db === "down" || redis === "down"
        ? "down"
        : ai === "down"
          ? "degraded"
          : "ok";
    return { status, db, redis, ai };
  }
}
