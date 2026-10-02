import {
  Global,
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { Redis } from "ioredis";

import { describeError, throttle } from "../../common/utils/describe-error";
import { APP_CONFIG } from "../../config/config.module";
import type { Env } from "../../config/env.schema";

export const REDIS = Symbol("REDIS");

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: Env): Redis => {
        const logger = new Logger("Redis");
        const redis = new Redis(config.REDIS_URL, {
          // Fail commands fast while disconnected (the health check reports "down" instead of hanging).
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) => Math.min(attempt * 200, 3000),
        });
        const warn = throttle((m) => logger.warn(m));
        redis.on("ready", () => logger.log("Connected"));
        redis.on("error", (err) =>
          warn(`Connection problem: ${describeError(err)}`),
        );
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
