import { Module } from "@nestjs/common";

import { QueueModule } from "../../queues/queue.module";
import { DemoModule } from "../demo/demo.module";
import { CollectionsModule } from "../collections/collections.module";
import { DocumentsController } from "./documents.controller";
import { DocumentsRepository } from "./documents.repository";
import { DocumentsService } from "./documents.service";

@Module({
  imports: [CollectionsModule, QueueModule, DemoModule],
  controllers: [DocumentsController],
  providers: [DocumentsRepository, DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
