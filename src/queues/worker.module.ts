import { Module } from "@nestjs/common";

import { AiModule } from "../integrations/ai/ai.module";
import { StorageModule } from "../integrations/storage/storage.module";
import { DocumentsRepository } from "../modules/documents/documents.repository";
import { ConfigModule } from "../config/config.module";
import { DatabaseModule } from "../database/database.module";
import { QueueModule } from "./queue.module";
import { IngestProcessor } from "./processors/ingest.processor";
import { EvalsModule } from "../modules/evals/evals.module";
import { EvalsProcessor } from "./processors/evals.processor";
import { ChatModule } from "../modules/chat/chat.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    QueueModule,
    AiModule,
    StorageModule,
    EvalsModule,
    ChatModule,
  ],
  providers: [DocumentsRepository, IngestProcessor, EvalsProcessor],
})
export class WorkerModule {}
