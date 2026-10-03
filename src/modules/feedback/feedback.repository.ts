import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";

export interface RatedAnswerRow extends Record<string, unknown> {
  resourceId: string;
  conversationId: string;
  question: string | null;
  answer: string;
  comment: string | null;
  createdAt: Date;
}

@Injectable()
export class FeedbackRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * The answers one user rated in one collection, newest rating first, each with the question that was asked: the closest
   * user message at or before the answer in the same conversation.
   */
  async ratedAnswers(
    userId: string,
    collectionId: string,
    rating: 1 | -1,
    limit: number,
  ): Promise<RatedAnswerRow[]> {
    const result = await this.db.execute<RatedAnswerRow>(sql`
      SELECT m.id AS "resourceId",
        m.conversation_id AS "conversationId",
        (
          SELECT q.content FROM messages q
          WHERE q.conversation_id = m.conversation_id AND q.role = 'user' AND q.created_at <= m.created_at
          ORDER BY q.created_at DESC, q.id DESC
          LIMIT 1
        ) AS question,
        m.content AS answer,
        f.comment,
        f.created_at AS "createdAt"
      FROM message_feedback f
      JOIN messages m ON m.id = f.message_id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.collection_id = ${collectionId} AND c.user_id = ${userId} AND f.user_id = ${userId}
        AND f.rating = ${rating}
      ORDER BY f.created_at DESC, m.id DESC
      LIMIT ${limit}
    `);
    return result.rows;
  }
}
