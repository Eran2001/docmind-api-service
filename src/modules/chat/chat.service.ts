import { Injectable, Logger } from "@nestjs/common";
import { performance } from "node:perf_hooks";

import {
  AiClient,
  AiServiceError,
  type AiUsage,
} from "../../integrations/ai/ai.client";
import { ConversationsService } from "../conversations/conversations.service";
import type { ModelUsage } from "../conversations/conversations.repository";
import { extractCitations } from "./citations";
import { RetrievalRepository } from "./retrieval.repository";

export type ChatSseEvent =
  | {
      event: "meta";
      data: { userMessageId: string; assistantMessageId: string };
    }
  | { event: "status"; data: { stage: "searching" | "generating" } }
  | { event: "token"; data: { text: string } }
  | {
      event: "done";
      data: {
        citations: ReturnType<typeof extractCitations>["citations"];
        usage: { inputTokens: number; outputTokens: number; costUsd: number };
        latencyMs: number;
        retrieval: { documents: number; passages: number };
      };
    }
  | { event: "error"; data: { code: string; message: string } };

const NO_SOURCES_ANSWER =
  "I couldn't find anything in your documents about that.";

const MODEL_PRICES_PER_MILLION: Record<
  string,
  { input: number; output: number }
> = {
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "llama3.2": { input: 0, output: 0 },
};

type EvalAnswerUsage = Omit<ModelUsage, "kind"> & { kind: "embed" | "answer" };

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly conversations: ConversationsService,
    private readonly retrieval: RetrievalRepository,
    private readonly ai: AiClient,
  ) {}

  async sendMessage(
    userId: string,
    conversationId: string,
    question: string,
    signal: AbortSignal,
    emit: (event: ChatSseEvent) => void,
  ): Promise<void> {
    const started = performance.now();
    const conversation = await this.conversations.requireOwned(
      userId,
      conversationId,
    );
    const history = await this.conversations.history(conversationId);
    const pair = await this.conversations.createMessagePair(
      userId,
      conversationId,
      question,
    );
    const partial: string[] = [];
    const modelUsage: ModelUsage[] = [];
    emit({ event: "meta", data: pair });
    emit({ event: "status", data: { stage: "searching" } });

    try {
      const hasReadyDocuments =
        (await this.retrieval.readyDocumentCount(conversation.collectionId)) >
        0;

      if (!hasReadyDocuments) {
        emit({ event: "token", data: { text: NO_SOURCES_ANSWER } });
        await this.finish(
          userId,
          conversationId,
          pair.assistantMessageId,
          NO_SOURCES_ANSWER,
          [],
          [],
          started,
          emit,
        );
        this.generateTitle(question, conversationId, history.length === 0);
        return;
      }

      let standaloneQuery = question;
      if (history.length > 0) {
        const rewritten = await this.ai.rewriteQuery(history, question, signal);
        standaloneQuery = rewritten.query.trim() || question;
        modelUsage.push(this.usageEvent("rewrite", rewritten.usage));
      }

      const embedded = await this.ai.embed([standaloneQuery], signal);
      modelUsage.push(this.usageEvent("embed", embedded.usage));
      const vector = embedded.embeddings[0];
      if (!vector)
        throw new AiServiceError(
          "AI_INVALID_RESPONSE",
          "The AI service returned no query embedding.",
        );

      const chunks = await this.retrieval.search(
        conversation.collectionId,
        vector,
        standaloneQuery,
      );
      if (chunks.length === 0) {
        emit({ event: "token", data: { text: NO_SOURCES_ANSWER } });
        await this.finish(
          userId,
          conversationId,
          pair.assistantMessageId,
          NO_SOURCES_ANSWER,
          [],
          modelUsage,
          started,
          emit,
        );
        this.generateTitle(question, conversationId, history.length === 0);
        return;
      }

      emit({ event: "status", data: { stage: "generating" } });
      const answerChunks = chunks.map((chunk) => ({
        id: chunk.id,
        document_title: chunk.documentTitle,
        page_number: chunk.pageNumber,
        content: chunk.content,
      }));
      let answerUsage: AiUsage | null = null;
      for await (const event of this.ai.answerStream(
        { question, history, chunks: answerChunks },
        signal,
      )) {
        if (event.event === "token") {
          partial.push(event.text);
          emit({ event: "token", data: { text: event.text } });
        } else {
          answerUsage = event.usage;
        }
      }
      if (!answerUsage)
        throw new AiServiceError(
          "AI_STREAM_FAILED",
          "The AI answer stream ended before completion.",
        );
      modelUsage.push(this.usageEvent("answer", answerUsage));

      const extracted = extractCitations(partial.join(""), chunks);
      const retrieval = {
        documents: new Set(chunks.map((chunk) => chunk.documentId)).size,
        passages: chunks.length,
      };
      await this.finish(
        userId,
        conversationId,
        pair.assistantMessageId,
        extracted.content,
        extracted.citations,
        modelUsage,
        started,
        emit,
        retrieval,
      );
      this.generateTitle(question, conversationId, history.length === 0);
    } catch (error) {
      const content = partial.join("");
      const latencyMs = Math.max(0, Math.round(performance.now() - started));
      await this.conversations
        .appendPartial(
          userId,
          conversationId,
          pair.assistantMessageId,
          content,
          latencyMs,
          modelUsage,
        )
        .catch(() => undefined);
      if (!signal.aborted) {
        this.logger.warn(
          `Chat answer failed (${error instanceof Error ? error.name : "unknown error"}).`,
        );
        emit({
          event: "error",
          data: {
            code: "AiServiceFailed",
            message:
              error instanceof AiServiceError
                ? error.message
                : "I couldn't generate an answer. Please try again.",
          },
        });
      }
      this.generateTitle(question, conversationId, history.length === 0);
    }
  }

  async saveFeedback(
    userId: string,
    messageId: string,
    input: { rating: 1 | -1; comment?: string },
  ): Promise<void> {
    await this.conversations.saveFeedback(
      userId,
      messageId,
      input.rating,
      input.comment ?? null,
    );
  }

  async answerForEval(
    collectionId: string,
    question: string,
    topK: number,
    signal: AbortSignal,
  ): Promise<{
    generatedAnswer: string;
    chunks: Awaited<ReturnType<RetrievalRepository["search"]>>;
    usage: EvalAnswerUsage[];
  }> {
    const usage: EvalAnswerUsage[] = [];
    if ((await this.retrieval.readyDocumentCount(collectionId)) === 0) {
      return { generatedAnswer: NO_SOURCES_ANSWER, chunks: [], usage };
    }
    const embedded = await this.ai.embed([question], signal);
    usage.push(this.usageEvent("embed", embedded.usage));
    const vector = embedded.embeddings[0];
    if (!vector)
      throw new AiServiceError(
        "AI_INVALID_RESPONSE",
        "The AI service returned no query embedding.",
      );
    const chunks = await this.retrieval.search(
      collectionId,
      vector,
      question,
      topK,
    );
    if (chunks.length === 0)
      return { generatedAnswer: NO_SOURCES_ANSWER, chunks, usage };
    const answer = await this.ai.answerOnce(
      {
        question,
        history: [],
        chunks: chunks.map((chunk) => ({
          id: chunk.id,
          document_title: chunk.documentTitle,
          page_number: chunk.pageNumber,
          content: chunk.content,
        })),
      },
      signal,
    );
    usage.push(this.usageEvent("answer", answer.usage));
    return { generatedAnswer: answer.answer, chunks, usage };
  }

  private async finish(
    userId: string,
    conversationId: string,
    assistantMessageId: string,
    answer: string,
    citations: ReturnType<typeof extractCitations>["citations"],
    modelUsage: ModelUsage[],
    started: number,
    emit: (event: ChatSseEvent) => void,
    retrieval = { documents: 0, passages: 0 },
  ): Promise<void> {
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    await this.conversations.completeAssistant(
      userId,
      conversationId,
      assistantMessageId,
      {
        content: answer,
        citations,
        latencyMs,
        usage: modelUsage,
      },
    );
    const inputTokens = modelUsage.reduce(
      (total, usage) => total + usage.inputTokens,
      0,
    );
    const outputTokens = modelUsage.reduce(
      (total, usage) => total + usage.outputTokens,
      0,
    );
    const costUsd = modelUsage.reduce(
      (total, usage) => total + usage.costUsd,
      0,
    );
    emit({
      event: "done",
      data: {
        citations,
        usage: { inputTokens, outputTokens, costUsd },
        latencyMs,
        retrieval,
      },
    });
  }

  private usageEvent<Kind extends ModelUsage["kind"]>(
    kind: Kind,
    usage: AiUsage,
  ): Omit<ModelUsage, "kind"> & { kind: Kind } {
    const pricing = MODEL_PRICES_PER_MILLION[usage.model];
    if (!pricing)
      this.logger.warn(
        `No usage price configured for model ${usage.model}; recording zero cost.`,
      );
    const costUsd = pricing
      ? (usage.input_tokens * pricing.input +
          usage.output_tokens * pricing.output) /
        1_000_000
      : 0;
    return {
      kind,
      model: usage.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costUsd,
      latencyMs: usage.latency_ms,
    };
  }

  private generateTitle(
    question: string,
    conversationId: string,
    firstExchange: boolean,
  ): void {
    if (!firstExchange) return;
    void this.ai
      .generateTitle(question)
      .then(({ title }) =>
        this.conversations.updateTitle(conversationId, title),
      )
      .catch((error: unknown) =>
        this.logger.warn(
          `Chat title generation failed (${error instanceof Error ? error.name : "unknown error"}).`,
        ),
      );
  }
}
