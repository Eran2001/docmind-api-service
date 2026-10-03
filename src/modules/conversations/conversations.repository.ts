import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { DB, type Database } from "../../database/database.module";
import {
  conversations,
  messageFeedback,
  messages,
  usageEvents,
} from "../../database/schema";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "error";
export type UsageKind = "embed" | "rewrite" | "rerank" | "answer";

export interface ModelUsage {
  kind: UsageKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface MessageWriteResult {
  userMessageId: string;
  assistantMessageId: string;
}

@Injectable()
export class ConversationsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * One page, newest activity first, ordered by (updated_at, id). `after` is the position of the last row of the previous page.
   * Each row carries `cursorTime`: its `updated_at` as text with MICROSECOND precision. A JS Date only has milliseconds, and
   * comparing against a truncated time would skip rows that fall between the two.
   */
  async list(
    userId: string,
    collectionId: string,
    page: { limit: number; after?: { time: string; id: string } },
  ): Promise<(ConversationRow & { cursorTime: string })[]> {
    const rows = await this.db
      .select({
        conversation: conversations,
        cursorTime: sql<string>`to_char(${conversations.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.collectionId, collectionId),
          page.after
            ? or(
                lt(
                  conversations.updatedAt,
                  sql`${page.after.time}::timestamptz`,
                ),
                and(
                  sql`${conversations.updatedAt} = ${page.after.time}::timestamptz`,
                  lt(conversations.id, page.after.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(page.limit);
    return rows.map((row) => ({
      ...row.conversation,
      cursorTime: row.cursorTime,
    }));
  }

  async create(userId: string, collectionId: string): Promise<ConversationRow> {
    const [row] = await this.db
      .insert(conversations)
      .values({ userId, collectionId })
      .returning();
    if (!row) throw new Error("Conversation insert returned no row");
    return row;
  }

  async findOwned(
    userId: string,
    id: string,
  ): Promise<ConversationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
      .limit(1);
    return row;
  }

  async deleteOwned(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
      .returning({ id: conversations.id });
    return rows.length > 0;
  }

  async createMessagePair(
    conversationId: string,
    question: string,
  ): Promise<MessageWriteResult> {
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const userCreatedAt = new Date();
    const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
    await this.db.transaction(async (tx) => {
      await tx.insert(messages).values([
        {
          id: userMessageId,
          conversationId,
          role: "user",
          content: question,
          status: "complete",
          createdAt: userCreatedAt,
        },
        {
          id: assistantMessageId,
          conversationId,
          role: "assistant",
          content: "",
          status: "streaming",
          createdAt: assistantCreatedAt,
        },
      ]);
      await tx
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    });
    return { userMessageId, assistantMessageId };
  }

  async recentHistory(
    conversationId: string,
    limit: number,
    excludeMessageId?: string,
  ): Promise<{ role: MessageRole; content: string }[]> {
    const rows = await this.db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.status, "complete"),
          excludeMessageId ? ne(messages.id, excludeMessageId) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);
    return rows
      .reverse()
      .map((row) => ({ role: row.role as MessageRole, content: row.content }));
  }

  async completeAssistant(
    userId: string,
    conversationId: string,
    messageId: string,
    input: {
      content: string;
      citations: unknown[];
      latencyMs: number;
      usage: ModelUsage[];
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({
          content: input.content,
          citations: input.citations,
          status: "complete",
          latencyMs: input.latencyMs,
        })
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.conversationId, conversationId),
          ),
        );
      if (input.usage.length > 0) {
        await tx.insert(usageEvents).values(
          input.usage.map((usage) => ({
            userId,
            kind: usage.kind,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: usage.costUsd.toFixed(6),
            latencyMs: usage.latencyMs,
            refType: "message",
            refId: messageId,
          })),
        );
      }
      await tx
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    });
  }

  async appendPartial(
    userId: string,
    conversationId: string,
    messageId: string,
    content: string,
    latencyMs: number,
    usage: ModelUsage[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ content, status: "error", latencyMs })
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.conversationId, conversationId),
          ),
        );
      if (usage.length > 0) {
        await tx.insert(usageEvents).values(
          usage.map((entry) => ({
            userId,
            kind: entry.kind,
            model: entry.model,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            costUsd: entry.costUsd.toFixed(6),
            latencyMs: entry.latencyMs,
            refType: "message",
            refId: messageId,
          })),
        );
      }
      await tx
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    });
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(eq(conversations.id, id));
  }

  async conversationDetail(userId: string, conversationId: string) {
    const rows = await this.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        role: messages.role,
        content: messages.content,
        citations: messages.citations,
        status: messages.status,
        latencyMs: messages.latencyMs,
        createdAt: messages.createdAt,
        feedbackRating: messageFeedback.rating,
        feedbackComment: messageFeedback.comment,
        usageInput: usageEvents.inputTokens,
        usageOutput: usageEvents.outputTokens,
        usageCost: usageEvents.costUsd,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(messageFeedback, eq(messageFeedback.messageId, messages.id))
      .leftJoin(
        usageEvents,
        and(
          eq(usageEvents.refId, messages.id),
          eq(usageEvents.refType, "message"),
        ),
      )
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, userId),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id));

    const grouped = new Map<
      string,
      {
        resourceId: string;
        conversationId: string;
        role: MessageRole;
        content: string;
        citations: unknown[];
        status: MessageStatus;
        latencyMs: number | null;
        createdAt: Date;
        feedback: { rating: 1 | -1; comment: string | null } | null;
        usageInput: number;
        usageOutput: number;
        usageCost: number;
        hasUsage: boolean;
      }
    >();

    for (const row of rows) {
      let message = grouped.get(row.id);
      if (!message) {
        message = {
          resourceId: row.id,
          conversationId: row.conversationId,
          role: row.role as MessageRole,
          content: row.content,
          citations: row.citations as unknown[],
          status: row.status as MessageStatus,
          latencyMs: row.latencyMs,
          createdAt: row.createdAt,
          feedback:
            row.feedbackRating === null
              ? null
              : {
                  rating: row.feedbackRating as 1 | -1,
                  comment: row.feedbackComment,
                },
          usageInput: 0,
          usageOutput: 0,
          usageCost: 0,
          hasUsage: false,
        };
        grouped.set(row.id, message);
      }
      if (row.usageInput !== null) {
        message.usageInput += row.usageInput;
        message.usageOutput += row.usageOutput ?? 0;
        message.usageCost += Number(row.usageCost ?? 0);
        message.hasUsage = true;
      }
    }

    return [...grouped.values()].map(
      ({ usageInput, usageOutput, usageCost, hasUsage, ...message }) => ({
        ...message,
        usage: hasUsage
          ? {
              inputTokens: usageInput,
              outputTokens: usageOutput,
              costUsd: usageCost,
            }
          : null,
      }),
    );
  }

  async saveFeedback(
    userId: string,
    messageId: string,
    rating: 1 | -1,
    comment: string | null,
  ): Promise<boolean> {
    const [owned] = await this.db
      .select({ messageId: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(messages.id, messageId),
          eq(conversations.userId, userId),
          eq(messages.role, "assistant"),
        ),
      )
      .limit(1);
    if (!owned) return false;
    await this.db
      .insert(messageFeedback)
      .values({ messageId, userId, rating, comment })
      .onConflictDoUpdate({
        target: messageFeedback.messageId,
        set: { userId, rating, comment, createdAt: new Date() },
      });
    return true;
  }
}
