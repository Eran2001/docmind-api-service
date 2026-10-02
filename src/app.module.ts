import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";

import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { APP_CONFIG, ConfigModule } from "./config/config.module";
import type { Env } from "./config/env.schema";
import { DatabaseModule } from "./database/database.module";
import { AiModule } from "./integrations/ai/ai.module";
import { StorageModule } from "./integrations/storage/storage.module";
import { RedisModule } from "./integrations/redis/redis.module";
import { AuthModule } from "./modules/auth/auth.module";
import { CollectionsModule } from "./modules/collections/collections.module";
import { ConversationsModule } from "./modules/conversations/conversations.module";
import { ChatModule } from "./modules/chat/chat.module";
import { EvalsModule } from "./modules/evals/evals.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { HealthModule } from "./modules/health/health.module";
import { DemoRestrictionGuard } from "./common/guards/demo-restriction.guard";
import { RateLimitGuard } from "./common/guards/rate-limit.guard";
import { QueueModule } from "./queues/queue.module";
import { UsageModule } from "./modules/usage/usage.module";

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: Env) => ({
        // Path-to-regexp 8 syntax; the default "*" triggers a legacy-route warning.
        forRoutes: ["{*splat}"],
        pinoHttp: {
          level: config.LOG_LEVEL,
          // The request id is set by the Fastify hook in app.setup.ts, so every log line carries it.
          genReqId: (req) => String(req.headers["x-request-id"]),
          // One compact line per request: the id, what was asked, and how it went. Headers stay out of the logs.
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({
              statusCode: res.statusCode,
            }),
          },
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              'res.headers["set-cookie"]',
              "*.password",
              "*.currentPassword",
              "*.newPassword",
            ],
            censor: "[redacted]",
          },
          // Health checks poll constantly; keep them out of the logs. (Behind Nest's middleware `url` is prefix-stripped.)
          autoLogging: {
            ignore: (req) =>
              (
                (req as { originalUrl?: string }).originalUrl ??
                req.url ??
                ""
              ).endsWith("/health"),
          },
          transport:
            config.NODE_ENV === "development"
              ? {
                  target: "pino-pretty",
                  options: { singleLine: true, translateTime: "HH:MM:ss.l" },
                }
              : undefined,
        },
      }),
    }),
    DatabaseModule,
    RedisModule,
    QueueModule,
    AiModule,
    StorageModule,
    AuthModule,
    CollectionsModule,
    ConversationsModule,
    ChatModule,
    EvalsModule,
    UsageModule,
    DocumentsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Registered after the JWT guard on purpose: they need `req.user`.
    { provide: APP_GUARD, useClass: DemoRestrictionGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
