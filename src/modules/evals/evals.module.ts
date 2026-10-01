import { Module } from "@nestjs/common";

import { QueueModule } from "../../queues/queue.module";
import { CollectionsModule } from "../collections/collections.module";
import { EvalsController } from "./evals.controller";
import { EvalsRepository } from "./evals.repository";
import { EvalsService } from "./evals.service";

@Module({
  imports: [CollectionsModule, QueueModule],
  controllers: [EvalsController],
  providers: [EvalsRepository, EvalsService],
  exports: [EvalsRepository, EvalsService],
})
export class EvalsModule {}
