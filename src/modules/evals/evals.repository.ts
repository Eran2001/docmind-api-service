import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import {
  collections,
  documents,
  evalQuestions,
  evalResults,
  evalRuns,
  evalSets,
  usageEvents,
} from "../../database/schema";

export type EvalSetRow = typeof evalSets.$inferSelect;
export type EvalQuestionRow = typeof evalQuestions.$inferSelect;
export type EvalRunRow = typeof evalRuns.$inferSelect;
export type NewEvalResult = typeof evalResults.$inferInsert;

export interface EvalRunForWorker {
  run: EvalRunRow;
  userId: string;
  collectionId: string;
}

@Injectable()
export class EvalsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async listSets(userId: string) {
    const rows = await this.db
      .select({ set: evalSets, collectionName: collections.name })
      .from(evalSets)
      .innerJoin(collections, eq(collections.id, evalSets.collectionId))
      .where(eq(evalSets.userId, userId))
      .orderBy(desc(evalSets.createdAt), desc(evalSets.id));
    return Promise.all(
      rows.map(async ({ set, collectionName }) => ({
        set,
        collectionName,
        questionCount: await this.countQuestions(set.id),
        lastRun: await this.lastCompletedRun(set.id),
      })),
    );
  }

  async createSet(
    userId: string,
    input: { name: string; description: string | null; collectionId: string },
  ): Promise<EvalSetRow> {
    const [row] = await this.db
      .insert(evalSets)
      .values({ ...input, userId })
      .returning();
    if (!row) throw new Error("Eval set insert returned no row");
    return row;
  }

  async findOwnedSet(userId: string, id: string) {
    const [row] = await this.db
      .select({ set: evalSets, collectionName: collections.name })
      .from(evalSets)
      .innerJoin(collections, eq(collections.id, evalSets.collectionId))
      .where(and(eq(evalSets.id, id), eq(evalSets.userId, userId)))
      .limit(1);
    return row;
  }

  async deleteSetOwned(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(evalSets)
      .where(and(eq(evalSets.id, id), eq(evalSets.userId, userId)))
      .returning({ id: evalSets.id });
    return rows.length > 0;
  }

  async questionsForSet(setId: string) {
    return this.db
      .select({
        question: evalQuestions,
        expectedDocumentTitle: documents.title,
      })
      .from(evalQuestions)
      .leftJoin(documents, eq(documents.id, evalQuestions.expectedDocumentId))
      .where(eq(evalQuestions.evalSetId, setId))
      .orderBy(asc(evalQuestions.createdAt), asc(evalQuestions.id));
  }

  async createQuestion(input: {
    evalSetId: string;
    question: string;
    expectedAnswer: string;
    expectedDocumentId: string | null;
  }): Promise<EvalQuestionRow> {
    const [row] = await this.db.insert(evalQuestions).values(input).returning();
    if (!row) throw new Error("Eval question insert returned no row");
    return row;
  }

  async expectedDocumentInCollection(
    documentId: string,
    collectionId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.collectionId, collectionId),
        ),
      )
      .limit(1);
    return !!row;
  }

  async deleteQuestionOwned(
    userId: string,
    questionId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .delete(evalQuestions)
      .where(
        sql`${evalQuestions.id} = ${questionId} AND EXISTS (
        SELECT 1 FROM eval_sets s WHERE s.id = ${evalQuestions.evalSetId} AND s.user_id = ${userId}
      )`,
      )
      .returning({ id: evalQuestions.id });
    return rows.length > 0;
  }

  async createRun(evalSetId: string, topK: number): Promise<EvalRunRow> {
    const [row] = await this.db
      .insert(evalRuns)
      .values({ evalSetId, status: "queued", config: { topK } })
      .returning();
    if (!row) throw new Error("Eval run insert returned no row");
    return row;
  }

  async questionCount(setId: string): Promise<number> {
    return this.countQuestions(setId);
  }

  async runOwned(userId: string, runId: string) {
    const [row] = await this.db
      .select({ run: evalRuns, evalSet: evalSets })
      .from(evalRuns)
      .innerJoin(evalSets, eq(evalSets.id, evalRuns.evalSetId))
      .where(and(eq(evalRuns.id, runId), eq(evalSets.userId, userId)))
      .limit(1);
    return row;
  }

  async runForWorker(runId: string): Promise<EvalRunForWorker | undefined> {
    const [row] = await this.db
      .select({
        run: evalRuns,
        userId: evalSets.userId,
        collectionId: evalSets.collectionId,
      })
      .from(evalRuns)
      .innerJoin(evalSets, eq(evalSets.id, evalRuns.evalSetId))
      .where(eq(evalRuns.id, runId))
      .limit(1);
    return row;
  }

  async runsForSet(setId: string): Promise<EvalRunRow[]> {
    return this.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.evalSetId, setId))
      .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id));
  }

  async resultsForRun(runId: string) {
    return this.db
      .select({
        result: evalResults,
        question: evalQuestions,
        expectedDocumentTitle: documents.title,
      })
      .from(evalResults)
      .innerJoin(
        evalQuestions,
        eq(evalQuestions.id, evalResults.evalQuestionId),
      )
      .leftJoin(documents, eq(documents.id, evalQuestions.expectedDocumentId))
      .where(eq(evalResults.evalRunId, runId))
      .orderBy(asc(evalQuestions.createdAt), asc(evalQuestions.id));
  }

  async runProgress(runId: string) {
    const [resultCount] = await this.db
      .select({ value: count() })
      .from(evalResults)
      .where(eq(evalResults.evalRunId, runId));
    const [usage] = await this.db
      .select({
        inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
        costUsd: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`,
        judgeModel: sql<
          string | null
        >`max(case when ${usageEvents.kind} = 'judge' then ${usageEvents.model} end)`,
      })
      .from(usageEvents)
      .where(
        and(eq(usageEvents.refType, "eval_run"), eq(usageEvents.refId, runId)),
      );
    return {
      done: resultCount?.value ?? 0,
      totalTokens:
        Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0),
      totalCostUsd: Number(usage?.costUsd ?? 0),
      judgeModel: usage?.judgeModel ?? "pending",
    };
  }

  async markRunRunning(runId: string): Promise<void> {
    await this.db
      .update(evalRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(evalRuns.id, runId));
  }

  async saveResultAndUsage(
    runId: string,
    userId: string,
    result: NewEvalResult,
    usage: {
      kind: "embed" | "answer" | "judge";
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      latencyMs: number;
    }[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(evalResults).values(result);
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
            refType: "eval_run",
            refId: runId,
          })),
        );
      }
    });
  }

  async recordRunUsage(
    userId: string,
    runId: string,
    usage: {
      kind: "embed" | "answer" | "judge";
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      latencyMs: number;
    },
  ): Promise<void> {
    await this.db.insert(usageEvents).values({
      userId,
      kind: usage.kind,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd.toFixed(6),
      latencyMs: usage.latencyMs,
      refType: "eval_run",
      refId: runId,
    });
  }

  async completeRun(
    runId: string,
    metrics: {
      avgCorrectness: number;
      avgFaithfulness: number;
      retrievalHitRate: number;
      totalCostUsd: number;
    },
  ): Promise<void> {
    await this.db
      .update(evalRuns)
      .set({
        avgCorrectness: String(metrics.avgCorrectness),
        avgFaithfulness: String(metrics.avgFaithfulness),
        retrievalHitRate: String(metrics.retrievalHitRate),
        totalCostUsd: String(metrics.totalCostUsd),
        status: "done",
        finishedAt: new Date(),
      })
      .where(eq(evalRuns.id, runId));
  }

  async failRun(runId: string): Promise<void> {
    await this.db
      .update(evalRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(evalRuns.id, runId));
  }

  private async countQuestions(setId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(evalQuestions)
      .where(eq(evalQuestions.evalSetId, setId));
    return row?.value ?? 0;
  }

  private async lastCompletedRun(setId: string) {
    const [row] = await this.db
      .select({
        avgCorrectness: evalRuns.avgCorrectness,
        finishedAt: evalRuns.finishedAt,
      })
      .from(evalRuns)
      .where(and(eq(evalRuns.evalSetId, setId), eq(evalRuns.status, "done")))
      .orderBy(desc(evalRuns.finishedAt))
      .limit(1);
    return row?.avgCorrectness === null || row?.finishedAt === null || !row
      ? null
      : {
          avgCorrectness: Number(row.avgCorrectness),
          finishedAt: row.finishedAt.toISOString(),
        };
  }
}
