import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiClient } from "../../integrations/ai/ai.client";
import { ChatService } from "../../modules/chat/chat.service";
import { EvalsRepository } from "../../modules/evals/evals.repository";
import { EvalsProcessor, type RunEvalJob } from "./evals.processor";

const runId = "00000000-0000-4000-8000-000000000401";
const setId = "00000000-0000-4000-8000-000000000402";
const userId = "00000000-0000-4000-8000-000000000403";
const collectionId = "00000000-0000-4000-8000-000000000404";
const questionId = "00000000-0000-4000-8000-000000000405";
const documentId = "00000000-0000-4000-8000-000000000406";
const chunkId = "00000000-0000-4000-8000-000000000407";

describe("EvalsProcessor", () => {
  let repository: {
    runForWorker: ReturnType<typeof vi.fn>;
    markRunRunning: ReturnType<typeof vi.fn>;
    questionsForSet: ReturnType<typeof vi.fn>;
    saveResultAndUsage: ReturnType<typeof vi.fn>;
    completeRun: ReturnType<typeof vi.fn>;
    failRun: ReturnType<typeof vi.fn>;
  };
  let chat: { answerForEval: ReturnType<typeof vi.fn> };
  let ai: {
    judge: ReturnType<typeof vi.fn>;
    isJudgeAvailable: ReturnType<typeof vi.fn>;
  };
  let processor: EvalsProcessor;

  beforeEach(() => {
    repository = {
      runForWorker: vi.fn().mockResolvedValue({
        run: { id: runId, evalSetId: setId, config: { topK: 4 } },
        userId,
        collectionId,
      }),
      markRunRunning: vi.fn().mockResolvedValue(undefined),
      questionsForSet: vi.fn().mockResolvedValue([
        {
          question: {
            id: questionId,
            question: "When can a purchase be returned?",
            expectedAnswer: "Within thirty days.",
            expectedDocumentId: documentId,
          },
          expectedDocumentTitle: "Returns.pdf",
        },
      ]),
      saveResultAndUsage: vi.fn().mockResolvedValue(undefined),
      completeRun: vi.fn().mockResolvedValue(undefined),
      failRun: vi.fn().mockResolvedValue(undefined),
    };
    chat = {
      answerForEval: vi.fn().mockResolvedValue({
        generatedAnswer: "Return within thirty days [1].",
        chunks: [
          {
            id: chunkId,
            documentId,
            content: "Return within thirty days.",
            documentTitle: "Returns.pdf",
            pageNumber: 2,
          },
        ],
        usage: [
          {
            kind: "answer",
            model: "llama3.2",
            inputTokens: 12,
            outputTokens: 6,
            costUsd: 0,
            latencyMs: 20,
          },
        ],
      }),
    };
    ai = {
      isJudgeAvailable: vi.fn().mockResolvedValue(true),
      judge: vi.fn().mockResolvedValue({
        correctness: 0.9,
        faithfulness: 1,
        reasoning: "The answer matches the source.",
        usage: {
          model: "llama3.2",
          input_tokens: 30,
          output_tokens: 8,
          latency_ms: 25,
        },
      }),
    };
    processor = new EvalsProcessor(
      repository as unknown as EvalsRepository,
      chat as unknown as ChatService,
      ai as unknown as AiClient,
    );
  });

  it("runs answer/retrieval and judging per question, then stores aggregates", async () => {
    await processor.process({
      name: "run-eval",
      data: { runId },
    } as Job<RunEvalJob>);

    expect(repository.markRunRunning).toHaveBeenCalledWith(runId);
    expect(chat.answerForEval).toHaveBeenCalledWith(
      collectionId,
      "When can a purchase be returned?",
      4,
      expect.any(AbortSignal),
    );
    expect(ai.judge).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "When can a purchase be returned?",
        expected: "Within thirty days.",
        generated: "Return within thirty days [1].",
        chunks: [
          {
            id: chunkId,
            document_title: "Returns.pdf",
            page_number: 2,
            content: "Return within thirty days.",
          },
        ],
      }),
    );
    expect(repository.saveResultAndUsage).toHaveBeenCalledWith(
      runId,
      userId,
      expect.objectContaining({
        evalQuestionId: questionId,
        retrievedChunkIds: [chunkId],
        correctness: "0.9",
        faithfulness: "1",
        retrievalHit: true,
      }),
      expect.arrayContaining([
        expect.objectContaining({ kind: "answer" }),
        expect.objectContaining({ kind: "judge" }),
      ]),
    );
    expect(repository.completeRun).toHaveBeenCalledWith(runId, {
      avgCorrectness: 0.9,
      avgFaithfulness: 1,
      retrievalHitRate: 1,
      totalCostUsd: 0,
    });
  });

  it("marks the run failed after the final BullMQ attempt", async () => {
    await processor.onFailed(
      {
        name: "run-eval",
        data: { runId },
        attemptsMade: 4,
        opts: { attempts: 4 },
      } as Job<RunEvalJob>,
      new Error("judge unavailable"),
    );

    expect(repository.failRun).toHaveBeenCalledWith(runId);
  });

  it("does not start paid RAG work while the judge route is unavailable", async () => {
    ai.isJudgeAvailable.mockResolvedValue(false);

    await expect(
      processor.process({
        name: "run-eval",
        data: { runId },
      } as Job<RunEvalJob>),
    ).rejects.toMatchObject({
      code: "JUDGE_UNAVAILABLE",
    });

    expect(repository.markRunRunning).not.toHaveBeenCalled();
    expect(chat.answerForEval).not.toHaveBeenCalled();
    expect(ai.judge).not.toHaveBeenCalled();
  });
});
