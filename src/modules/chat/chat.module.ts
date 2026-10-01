import { Module } from "@nestjs/common";

import { AiModule } from "../../integrations/ai/ai.module";
import { ConversationsModule } from "../conversations/conversations.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { RetrievalRepository } from "./retrieval.repository";

@Module({
  imports: [AiModule, ConversationsModule],
  controllers: [ChatController],
  providers: [ChatService, RetrievalRepository],
  exports: [ChatService],
})
export class ChatModule {}
