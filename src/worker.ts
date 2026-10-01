import "dotenv/config";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { WorkerModule } from "./queues/worker.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
}

void bootstrap().catch((error: unknown) => {
  const logger = new Logger("Worker");
  logger.error(
    `Worker failed to start: ${error instanceof Error ? error.name : "unknown error"}`,
  );
  process.exitCode = 1;
});
