import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Job } from "bullmq";

import {
  AiClient,
  AiServiceError,
  type AiUsage,
} from "../../integrations/ai/ai.client";
import { ChatService } from "../../modules/chat/chat.service";
import { costUsd } from "../../modules/usage/pricing";
import { EvalsRepository } from "../../modules/evals/evals.repository";
import { QUEUES } from "../../config/constants";

export interface RunEvalJob {
  runId: string;
}

@Processor(QUEUES.EVALS)
@Injectable()
export class EvalsProcessor extends WorkerHost {
  private readonly logger = new Logger(EvalsProcessor.name);

  constructor(
    private readonly evals: EvalsRepository,
    private readonly chat: ChatService,
    private readonly ai: AiClient,
  ) {
    super();
  }

  async process(job: Job<RunEvalJob>): Promise<void> {
    if (job.name !== "run-eval")
      throw new Error(`Unsupported eval job: ${job.name}`);
    if (!(await this.ai.isJudgeAvailable())) {
      throw new AiServiceError(
        "JUDGE_UNAVAILABLE",
        "Eval scoring is paused until the AI judge endpoint is available.",
      );
    }
    const context = await this.evals.runForWorker(job.data.runId);
    if (!context) return;

    await this.evals.markRunRunning(job.data.runId);
    const questions = await this.evals.questionsForSet(context.run.evalSetId);
    const config =
      typeof context.run.config === "object" && context.run.config !== null
        ? (context.run.config as { topK?: unknown })
        : {};
    const topK =
      typeof config.topK === "number" &&
      Number.isInteger(config.topK) &&
      config.topK > 0
        ? Math.min(config.topK, 20)
        : 8;
    const scores: {
      correctness: number;
      faithfulness: number;
      hit: boolean;
    }[] = [];
    let totalCostUsd = 0;

    for (const { question } of questions) {
      const generated = await this.chat.answerForEval(
        context.collectionId,
        question.question,
        topK,
        AbortSignal.timeout(120_000),
      );
      const answerChunks = generated.chunks.map((chunk) => ({
        id: chunk.id,
        document_title: chunk.documentTitle,
        page_number: chunk.pageNumber,
        content: chunk.content,
      }));
      const judged = await this.ai.judge({
        question: question.question,
        expected: question.expectedAnswer,
        generated: generated.generatedAnswer,
        chunks: answerChunks,
      });
      const retrievalHit =
        question.expectedDocumentId === null ||
        generated.chunks.some(
          (chunk) => chunk.documentId === question.expectedDocumentId,
        );
      const judgeUsage = usageRecord("judge", judged.usage);
      const usage = [...generated.usage, judgeUsage];
      totalCostUsd += usage.reduce((total, event) => total + event.costUsd, 0);
      scores.push({
        correctness: judged.correctness,
        faithfulness: judged.faithfulness,
        hit: retrievalHit,
      });
      await this.evals.saveResultAndUsage(
        job.data.runId,
        context.userId,
        {
          evalRunId: job.data.runId,
          evalQuestionId: question.id,
          generatedAnswer: generated.generatedAnswer,
          retrievedChunkIds: generated.chunks.map((chunk) => chunk.id),
          correctness: String(judged.correctness),
          faithfulness: String(judged.faithfulness),
          retrievalHit,
          judgeReasoning: judged.reasoning,
        },
        usage,
      );
    }

    const average = (values: number[]) =>
      values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;
    await this.evals.completeRun(job.data.runId, {
      avgCorrectness: average(scores.map((score) => score.correctness)),
      avgFaithfulness: average(scores.map((score) => score.faithfulness)),
      retrievalHitRate: average(scores.map((score) => (score.hit ? 1 : 0))),
      totalCostUsd,
    });
  }

  @OnWorkerEvent("failed")
  async onFailed(
    job: Job<RunEvalJob> | undefined,
    error: Error,
  ): Promise<void> {
    if (
      !job ||
      job.name !== "run-eval" ||
      job.attemptsMade < (job.opts.attempts ?? 1)
    )
      return;
    this.logger.warn(`Eval run ${job.data.runId} failed (${error.name}).`);
    await this.evals.failRun(job.data.runId).catch(() => undefined);
  }
}

function usageRecord(kind: "judge", usage: AiUsage) {
  return {
    kind,
    model: usage.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    costUsd: costUsd(usage.model, usage.input_tokens, usage.output_tokens),
    latencyMs: usage.latency_ms,
  };
}
