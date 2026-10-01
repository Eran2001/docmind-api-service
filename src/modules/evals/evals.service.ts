import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

import { AppError } from "../../common/errors/app-error";
import { RETRIEVAL, QUEUES } from "../../config/constants";
import { CollectionsService } from "../collections/collections.service";
import {
  EvalsRepository,
  type EvalRunRow,
  type EvalSetRow,
} from "./evals.repository";
import type {
  CreateEvalQuestionInput,
  CreateEvalSetInput,
  StartEvalRunInput,
} from "./dto/evals.schemas";

export interface PublicEvalQuestion {
  resourceId: string;
  question: string;
  expectedAnswer: string;
  expectedDocumentId: string | null;
  expectedDocumentTitle: string | null;
}

@Injectable()
export class EvalsService {
  constructor(
    private readonly evals: EvalsRepository,
    private readonly collections: CollectionsService,
    @InjectQueue(QUEUES.EVALS) private readonly queue: Queue,
  ) {}

  async listSets(userId: string) {
    const rows = await this.evals.listSets(userId);
    return Promise.all(
      rows.map(({ set, collectionName, questionCount, lastRun }) => ({
        ...this.publicSet(set, collectionName),
        questionCount,
        lastRun,
      })),
    );
  }

  async createSet(userId: string, input: CreateEvalSetInput) {
    await this.collections.requireOwned(userId, input.collectionId);
    const row = await this.evals.createSet(userId, {
      name: input.name,
      description: input.description ?? null,
      collectionId: input.collectionId,
    });
    const found = await this.evals.findOwnedSet(userId, row.id);
    if (!found) throw AppError.notFound("Eval set");
    return {
      ...this.publicSet(found.set, found.collectionName),
      questionCount: 0,
      lastRun: null,
    };
  }

  async getSet(userId: string, id: string) {
    const found = await this.evals.findOwnedSet(userId, id);
    if (!found) throw AppError.notFound("Eval set");
    const [questions, runRows] = await Promise.all([
      this.evals.questionsForSet(id),
      this.evals.runsForSet(id),
    ]);
    const runs = await this.summaries(runRows, questions.length);
    const lastRun = runs.find((run) => run.status === "done");
    return {
      ...this.publicSet(found.set, found.collectionName),
      questionCount: questions.length,
      lastRun:
        lastRun?.avgCorrectness !== null && lastRun?.finishedAt
          ? {
              avgCorrectness: lastRun.avgCorrectness,
              finishedAt: lastRun.finishedAt,
            }
          : null,
      questions: questions.map(({ question, expectedDocumentTitle }) =>
        this.publicQuestion(question, expectedDocumentTitle),
      ),
      runs,
    };
  }

  async removeSet(userId: string, id: string): Promise<void> {
    if (!(await this.evals.deleteSetOwned(userId, id)))
      throw AppError.notFound("Eval set");
  }

  async addQuestion(
    userId: string,
    setId: string,
    input: CreateEvalQuestionInput,
  ): Promise<PublicEvalQuestion> {
    const found = await this.evals.findOwnedSet(userId, setId);
    if (!found) throw AppError.notFound("Eval set");
    const expectedDocumentId = input.expectedDocumentId ?? null;
    if (
      expectedDocumentId &&
      !(await this.evals.expectedDocumentInCollection(
        expectedDocumentId,
        found.set.collectionId,
      ))
    ) {
      throw AppError.notFound("Document");
    }
    const question = await this.evals.createQuestion({
      evalSetId: setId,
      question: input.question,
      expectedAnswer: input.expectedAnswer,
      expectedDocumentId,
    });
    const expectedDocumentTitle = expectedDocumentId
      ? ((await this.evals.questionsForSet(setId)).find(
          (row) => row.question.id === question.id,
        )?.expectedDocumentTitle ?? null)
      : null;
    return this.publicQuestion(question, expectedDocumentTitle);
  }

  async removeQuestion(userId: string, id: string): Promise<void> {
    if (!(await this.evals.deleteQuestionOwned(userId, id)))
      throw AppError.notFound("Eval question");
  }

  async startRun(userId: string, setId: string, input: StartEvalRunInput = {}) {
    const found = await this.evals.findOwnedSet(userId, setId);
    if (!found) throw AppError.notFound("Eval set");
    const total = await this.evals.questionCount(setId);
    if (total === 0)
      throw AppError.limit("Add at least one question before running an eval.");
    const existingRuns = await this.evals.runsForSet(setId);
    const row = await this.evals.createRun(
      setId,
      input.topK ?? RETRIEVAL.TOP_K,
    );
    try {
      await this.queue.add(
        "run-eval",
        { runId: row.id },
        {
          jobId: `${row.id}-${Date.now()}`,
          attempts: 4,
          backoff: { type: "fixed", delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 1000,
        },
      );
    } catch {
      await this.evals.failRun(row.id);
      throw AppError.unavailable(
        "The eval queue is unavailable. Try again shortly.",
      );
    }
    return this.publicRun(row, total, existingRuns.length + 1, {
      done: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      judgeModel: "pending",
    });
  }

  async getRun(userId: string, id: string) {
    const found = await this.evals.runOwned(userId, id);
    if (!found) throw AppError.notFound("Eval run");
    const [runRows, total, resultRows, metrics] = await Promise.all([
      this.evals.runsForSet(found.run.evalSetId),
      this.evals.questionCount(found.run.evalSetId),
      this.evals.resultsForRun(id),
      this.evals.runProgress(id),
    ]);
    const index = runRows.findIndex((row) => row.id === id);
    if (index < 0) throw AppError.notFound("Eval run");
    const number = runRows.length - index;
    return {
      ...this.publicRun(found.run, total, number, metrics),
      results: resultRows.map(
        ({ result, question, expectedDocumentTitle }) => ({
          questionId: result.evalQuestionId,
          question: question.question,
          expectedAnswer: question.expectedAnswer,
          expectedDocumentTitle,
          generatedAnswer: result.generatedAnswer,
          correctness: Number(result.correctness),
          faithfulness: Number(result.faithfulness),
          retrievalHit: result.retrievalHit,
          judgeReasoning: result.judgeReasoning,
        }),
      ),
    };
  }

  private async summaries(rows: EvalRunRow[], questionCount: number) {
    return Promise.all(
      rows.map(async (row, index) => {
        const metrics = await this.evals.runProgress(row.id);
        return this.publicRun(row, questionCount, rows.length - index, metrics);
      }),
    );
  }

  private publicSet(row: EvalSetRow, collectionName: string) {
    return {
      resourceId: row.id,
      name: row.name,
      description: row.description,
      collectionId: row.collectionId,
      collectionName,
    };
  }

  private publicQuestion(
    row: {
      id: string;
      question: string;
      expectedAnswer: string;
      expectedDocumentId: string | null;
    },
    expectedDocumentTitle: string | null,
  ): PublicEvalQuestion {
    return {
      resourceId: row.id,
      question: row.question,
      expectedAnswer: row.expectedAnswer,
      expectedDocumentId: row.expectedDocumentId,
      expectedDocumentTitle,
    };
  }

  private publicRun(
    row: EvalRunRow,
    total: number,
    number: number,
    metrics: {
      done: number;
      totalTokens: number;
      totalCostUsd: number;
      judgeModel: string;
    },
  ) {
    const startedAt = row.startedAt?.toISOString() ?? null;
    const finishedAt = row.finishedAt?.toISOString() ?? null;
    return {
      resourceId: row.id,
      evalSetId: row.evalSetId,
      number,
      status: row.status as "queued" | "running" | "done" | "failed",
      avgCorrectness:
        row.avgCorrectness === null ? null : Number(row.avgCorrectness),
      avgFaithfulness:
        row.avgFaithfulness === null ? null : Number(row.avgFaithfulness),
      retrievalHitRate:
        row.retrievalHitRate === null ? null : Number(row.retrievalHitRate),
      totalCostUsd: row.totalCostUsd === null ? null : Number(row.totalCostUsd),
      totalTokens: metrics.totalTokens,
      judgeModel: metrics.judgeModel,
      progress: { done: metrics.done, total },
      startedAt,
      finishedAt,
      durationMs:
        startedAt && finishedAt
          ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
          : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
