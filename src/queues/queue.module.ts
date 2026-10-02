import { BullModule, InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { RedisOptions } from "ioredis";

import { describeError, throttle } from "../common/utils/describe-error";
import { APP_CONFIG } from "../config/config.module";
import { QUEUES } from "../config/constants";
import type { Env } from "../config/env.schema";

/** BullMQ wants connection options (not a URL), and `maxRetriesPerRequest: null` is required for workers. */
export function redisConnectionOptions(url: string): RedisOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** A BullMQ Queue is an EventEmitter: an unhandled "error" event (Redis down) would crash the process. */
@Injectable()
class QueueErrorLogger implements OnModuleInit {
  private readonly logger = new Logger("Queue");

  constructor(
    @InjectQueue(QUEUES.INGEST) private readonly ingest: Queue,
    @InjectQueue(QUEUES.EVALS) private readonly evals: Queue,
  ) {}

  onModuleInit(): void {
    for (const queue of [this.ingest, this.evals]) {
      const warn = throttle((m) => this.logger.warn(m));
      queue.on("error", (err) => warn(`${queue.name}: ${describeError(err)}`));
    }
  }
}

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: Env) => ({
        connection: redisConnectionOptions(config.REDIS_URL),
      }),
    }),
    BullModule.registerQueue({ name: QUEUES.INGEST }, { name: QUEUES.EVALS }),
  ],
  providers: [QueueErrorLogger],
  exports: [BullModule],
})
export class QueueModule {}
