import { Module } from "@nestjs/common";

import { CollectionsModule } from "../collections/collections.module";
import { ConversationsController } from "./conversations.controller";
import { ConversationsRepository } from "./conversations.repository";
import { ConversationsService } from "./conversations.service";

@Module({
  imports: [CollectionsModule],
  controllers: [ConversationsController],
  providers: [ConversationsRepository, ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
