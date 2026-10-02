import "reflect-metadata";
import "dotenv/config";

import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module";
import { configureApp, createAdapter } from "./app.setup";
import { EnvValidationError, loadEnv } from "./config/env.schema";

async function bootstrap(): Promise<void> {
  const config = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createAdapter(),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  await configureApp(app, config);
  await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
}

bootstrap().catch((err: unknown) => {
  // A bad .env is a mistake to fix, not a bug: print just the message.
  console.error(err instanceof EnvValidationError ? err.message : err);
  process.exit(1);
});
