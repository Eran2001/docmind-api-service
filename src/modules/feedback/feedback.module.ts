import { Module } from "@nestjs/common";

import { CollectionsModule } from "../collections/collections.module";
import { FeedbackController } from "./feedback.controller";
import { FeedbackRepository } from "./feedback.repository";
import { FeedbackService } from "./feedback.service";

@Module({
  imports: [CollectionsModule],
  controllers: [FeedbackController],
  providers: [FeedbackRepository, FeedbackService],
})
export class FeedbackModule {}
