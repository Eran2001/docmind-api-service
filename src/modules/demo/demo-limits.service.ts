import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt, sql } from "drizzle-orm";

import { AppError } from "../../common/errors/app-error";
import { DEMO } from "../../config/constants";
import { DB, type Database } from "../../database/database.module";
import { users } from "../../database/schema";

/**
 * What a demo visitor may still do. Each call takes one unit with a single UPDATE ("add 1 only while under the limit"),
 * so two requests at once can't both slip through. Callers only call this for demo tokens (`req.user.demo`).
 */
@Injectable()
export class DemoLimitsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  reserveQuestion(userId: string): Promise<void> {
    return this.reserve(
      userId,
      "question",
      `You've used your ${DEMO.QUESTIONS} demo questions. Create a free account to keep chatting.`,
    );
  }

  reserveUpload(userId: string): Promise<void> {
    return this.reserve(
      userId,
      "upload",
      `The demo allows ${DEMO.UPLOADS} upload. Create a free account to add more documents.`,
    );
  }

  /** Gives a unit back when the work it was reserved for never started (a rejected file, say). */
  async refund(userId: string, kind: "question" | "upload"): Promise<void> {
    const column =
      kind === "question" ? users.demoQuestionsUsed : users.demoUploadsUsed;
    const field = kind === "question" ? "demoQuestionsUsed" : "demoUploadsUsed";
    await this.db
      .update(users)
      .set({ [field]: sql`greatest(${column} - 1, 0)` })
      .where(and(eq(users.id, userId), eq(users.isDemo, true)));
  }

  private async reserve(
    userId: string,
    kind: "question" | "upload",
    message: string,
  ): Promise<void> {
    const isQuestion = kind === "question";
    const column = isQuestion ? users.demoQuestionsUsed : users.demoUploadsUsed;
    const limit = isQuestion ? DEMO.QUESTIONS : DEMO.UPLOADS;
    const updated = await this.db
      .update(users)
      .set({
        [isQuestion ? "demoQuestionsUsed" : "demoUploadsUsed"]:
          sql`${column} + 1`,
      })
      .where(
        and(eq(users.id, userId), eq(users.isDemo, true), lt(column, limit)),
      )
      .returning({ id: users.id });
    if (updated.length === 0) throw AppError.demoLimit(message);
  }
}
