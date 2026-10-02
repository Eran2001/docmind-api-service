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

const encodeCursor = (time: string, id: string) =>
  Buffer.from(JSON.stringify({ t: time, i: id })).toString("base64url");

function decodeCursor(cursor: string): { time: string; id: string } {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as {
      t?: unknown;
      i?: unknown;
    };
    if (
      typeof value.t === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.t) &&
      typeof value.i === "string" &&
      /^[0-9a-f-]{36}$/i.test(value.i)
    )
      return { time: value.t, id: value.i };
  } catch {
    // falls through to the error below
  }
  throw AppError.validation("That cursor is not valid.", {
    fieldErrors: { cursor: ["That cursor is not valid."] },
  });
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

  /** A page of conversations plus `nextCursor` (null on the last page). The cursor is opaque to clients. */
  async list(
    userId: string,
    collectionId: string,
    page: { limit: number; cursor?: string },
  ): Promise<{ items: PublicConversation[]; nextCursor: string | null }> {
    await this.collections.requireOwned(userId, collectionId);
    const after = page.cursor ? decodeCursor(page.cursor) : undefined;
    // One extra row tells us whether another page exists.
    const rows = await this.conversations.list(userId, collectionId, {
      limit: page.limit + 1,
      after,
    });
    const hasMore = rows.length > page.limit;
    const pageRows = rows.slice(0, page.limit);
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toPublic),
      nextCursor:
        hasMore && last ? encodeCursor(last.cursorTime, last.id) : null,
    };
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
