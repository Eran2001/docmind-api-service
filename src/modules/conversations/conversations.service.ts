import { Injectable } from "@nestjs/common";

import { AppError } from "../../common/errors/app-error";
import { CollectionsService } from "../collections/collections.service";
import {
  ConversationsRepository,
  type ConversationRow,
  type ModelUsage,
} from "./conversations.repository";

export interface PublicConversation {
  resourceId: string;
  collectionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const toPublic = (row: ConversationRow): PublicConversation => ({
  resourceId: row.id,
  collectionId: row.collectionId,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

@Injectable()
export class ConversationsService {
  constructor(
    private readonly conversations: ConversationsRepository,
    private readonly collections: CollectionsService,
  ) {}

  async create(
    userId: string,
    collectionId: string,
  ): Promise<PublicConversation> {
    await this.collections.requireOwned(userId, collectionId);
    return toPublic(await this.conversations.create(userId, collectionId));
  }

  async list(
    userId: string,
    collectionId: string,
    limit: number,
  ): Promise<PublicConversation[]> {
    await this.collections.requireOwned(userId, collectionId);
    return (await this.conversations.list(userId, collectionId))
      .slice(0, limit)
      .map(toPublic);
  }

  async get(userId: string, conversationId: string) {
    const row = await this.requireOwned(userId, conversationId);
    const messages = await this.conversations.conversationDetail(
      userId,
      conversationId,
    );
    return { ...toPublic(row), messages };
  }

  async remove(userId: string, conversationId: string): Promise<void> {
    if (!(await this.conversations.deleteOwned(userId, conversationId)))
      throw AppError.notFound("Conversation");
  }

  async requireOwned(
    userId: string,
    conversationId: string,
  ): Promise<ConversationRow> {
    const row = await this.conversations.findOwned(userId, conversationId);
    if (!row) throw AppError.notFound("Conversation");
    return row;
  }

  async createMessagePair(
    userId: string,
    conversationId: string,
    question: string,
  ) {
    await this.requireOwned(userId, conversationId);
    return this.conversations.createMessagePair(conversationId, question);
  }

  async history(conversationId: string) {
    return this.conversations.recentHistory(conversationId, 6);
  }

  async completeAssistant(
    userId: string,
    conversationId: string,
    assistantMessageId: string,
    input: {
      content: string;
      citations: unknown[];
      latencyMs: number;
      usage: ModelUsage[];
    },
  ): Promise<void> {
    await this.conversations.completeAssistant(
      userId,
      conversationId,
      assistantMessageId,
      input,
    );
  }

  async appendPartial(
    userId: string,
    conversationId: string,
    assistantMessageId: string,
    content: string,
    latencyMs: number,
    usage: ModelUsage[],
  ): Promise<void> {
    await this.conversations.appendPartial(
      userId,
      conversationId,
      assistantMessageId,
      content,
      latencyMs,
      usage,
    );
  }

  async updateTitle(conversationId: string, title: string): Promise<void> {
    await this.conversations.updateTitle(conversationId, title);
  }

  async saveFeedback(
    userId: string,
    messageId: string,
    rating: 1 | -1,
    comment: string | null,
  ): Promise<void> {
    if (
      !(await this.conversations.saveFeedback(
        userId,
        messageId,
        rating,
        comment,
      ))
    ) {
      throw AppError.notFound("Message");
    }
  }
}
