import { Injectable } from "@nestjs/common";
import { z } from "zod";

import { InjectConfig } from "../../config/config.module";
import type { Env } from "../../config/env.schema";

const usageSchema = z.object({
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  latency_ms: z.number().int().nonnegative(),
});

export type AiUsage = z.infer<typeof usageSchema>;

const embeddingResponseSchema = z.object({
  embeddings: z.array(z.array(z.number()).length(1536)),
  usage: usageSchema,
});

const rewriteResponseSchema = z.object({
  query: z.string(),
  usage: usageSchema,
});
const titleResponseSchema = z.object({ title: z.string(), usage: usageSchema });
const rerankResponseSchema = z.object({
  ids: z.array(z.string()),
  usage: usageSchema,
});

const chunkSchema = z.object({
  index: z.number().int().nonnegative(),
  content: z.string(),
  page_number: z.number().int().positive().nullable(),
  heading: z.string().nullable(),
  token_count: z.number().int().nonnegative(),
  embedding: z.array(z.number()).length(1536),
});

const ingestResponseSchema = z.object({
  title: z.string().nullable().optional(),
  page_count: z.number().int().positive().nullable(),
  chunks: z.array(chunkSchema),
  usage: usageSchema,
});
const answerResponseSchema = z.object({
  answer: z.string(),
  usage: usageSchema,
});
const judgeResponseSchema = z.object({
  correctness: z.number().min(0).max(1),
  faithfulness: z.number().min(0).max(1),
  reasoning: z.string(),
  usage: usageSchema,
});

export type IngestResponse = z.infer<typeof ingestResponseSchema>;

export type AiAnswerEvent =
  { event: "token"; text: string } | { event: "done"; usage: AiUsage };

export interface AiHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiAnswerChunk {
  id: string;
  document_title: string;
  page_number: number | null;
  content: string;
}

export class AiServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AiServiceError";
  }
}

const AI_TIMEOUT_MS = 120_000;

/** Typed client for the internal Python AI service. */
@Injectable()
export class AiClient {
  constructor(@InjectConfig() private readonly config: Env) {}

  private headers(): Record<string, string> {
    return { "X-Internal-Key": this.config.INTERNAL_API_KEY };
  }

  async ingestFile(
    file: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<IngestResponse> {
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(file)], { type: mimeType }),
      filename,
    );
    form.set("mime_type", mimeType);
    return this.ingest("/ingest/file", form);
  }

  async ingestUrl(url: string): Promise<IngestResponse> {
    return this.ingest("/ingest/url", JSON.stringify({ url }), true);
  }

  async embed(texts: string[], signal?: AbortSignal) {
    return this.postJson("/embed", { texts }, embeddingResponseSchema, signal);
  }

  async rewriteQuery(
    history: AiHistoryMessage[],
    question: string,
    signal?: AbortSignal,
  ) {
    return this.postJson(
      "/rewrite-query",
      { history, question },
      rewriteResponseSchema,
      signal,
    );
  }

  /** Asks the rerank model to put the best `topN` of these passages first. Returns their ids, best first. */
  async rerank(
    question: string,
    passages: { id: string; text: string }[],
    topN: number,
    signal?: AbortSignal,
  ) {
    return this.postJson(
      "/rerank",
      { question, passages, top_n: topN },
      rerankResponseSchema,
      signal,
    );
  }

  async generateTitle(question: string, signal?: AbortSignal) {
    return this.postJson("/title", { question }, titleResponseSchema, signal);
  }

  async answerOnce(
    input: {
      question: string;
      history: AiHistoryMessage[];
      chunks: AiAnswerChunk[];
    },
    signal?: AbortSignal,
  ) {
    return this.postJson(
      "/answer",
      { ...input, stream: false },
      answerResponseSchema,
      signal,
    );
  }

  async judge(
    input: {
      question: string;
      expected: string;
      generated: string;
      chunks: AiAnswerChunk[];
    },
    signal?: AbortSignal,
  ) {
    return this.postJson("/evals/judge", input, judgeResponseSchema, signal);
  }

  async isJudgeAvailable(): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.config.AI_SERVICE_URL}/evals/judge`,
        {
          method: "POST",
          headers: { ...this.headers(), "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(3000),
        },
      );
      return response.status === 422;
    } catch {
      return false;
    }
  }

  async *answerStream(
    input: {
      question: string;
      history: AiHistoryMessage[];
      chunks: AiAnswerChunk[];
    },
    signal: AbortSignal,
  ): AsyncGenerator<AiAnswerEvent> {
    let response: Response;
    try {
      response = await fetch(`${this.config.AI_SERVICE_URL}/answer`, {
        method: "POST",
        headers: {
          ...this.headers(),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ ...input, stream: true }),
        signal,
      });
    } catch {
      if (signal.aborted) throw new Error("AI answer stream aborted.");
      throw new AiServiceError(
        "AI_UNAVAILABLE",
        "The AI service could not be reached.",
      );
    }
    if (!response.ok) throw await this.responseError(response);
    if (!response.body)
      throw new AiServiceError(
        "AI_INVALID_RESPONSE",
        "The AI service returned no answer stream.",
      );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const event = this.parseAnswerEvent(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event) {
            if (event.event === "done") completed = true;
            yield event;
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim()) {
        const event = this.parseAnswerEvent(buffer);
        if (event) {
          if (event.event === "done") completed = true;
          yield event;
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof AiServiceError) throw error;
      throw new AiServiceError(
        "AI_STREAM_FAILED",
        "The AI answer stream ended unexpectedly.",
      );
    } finally {
      reader.releaseLock();
    }
    if (!completed && !signal.aborted) {
      throw new AiServiceError(
        "AI_STREAM_FAILED",
        "The AI answer stream ended before completion.",
      );
    }
  }

  private async ingest(
    path: string,
    body: FormData | string,
    json = false,
  ): Promise<IngestResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.config.AI_SERVICE_URL}${path}`, {
        method: "POST",
        headers: {
          ...this.headers(),
          ...(json ? { "Content-Type": "application/json" } : {}),
        },
        body,
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
    } catch {
      throw new AiServiceError(
        "AI_UNAVAILABLE",
        "The AI service could not be reached.",
      );
    }

    if (!response.ok) throw await this.responseError(response);
    const payload: unknown = await response.json().catch(() => null);
    const parsed = ingestResponseSchema.safeParse(payload);
    if (!parsed.success)
      throw new AiServiceError(
        "AI_INVALID_RESPONSE",
        "The AI service returned invalid ingestion data.",
      );
    return parsed.data;
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.AI_SERVICE_URL}${path}`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(AI_TIMEOUT_MS),
      });
    } catch {
      if (signal?.aborted) throw new Error("AI request aborted.");
      throw new AiServiceError(
        "AI_UNAVAILABLE",
        "The AI service could not be reached.",
      );
    }
    if (!response.ok) throw await this.responseError(response);
    const payload: unknown = await response.json().catch(() => null);
    const parsed = schema.safeParse(payload);
    if (!parsed.success)
      throw new AiServiceError(
        "AI_INVALID_RESPONSE",
        "The AI service returned invalid data.",
      );
    return parsed.data;
  }

  private async responseError(response: Response): Promise<AiServiceError> {
    const payload: unknown = await response.json().catch(() => null);
    const parsed = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(payload);
    if (parsed.success)
      return new AiServiceError(
        parsed.data.error.code,
        parsed.data.error.message,
      );
    return new AiServiceError(
      "AI_UNAVAILABLE",
      "The AI service returned an unexpected error.",
    );
  }

  private parseAnswerEvent(frame: string): AiAnswerEvent | null {
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:"))
        dataLines.push(line.slice(5).trimStart());
    }
    if (!eventName || dataLines.length === 0) return null;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n")) as unknown;
    } catch {
      return null;
    }
    if (eventName === "token") {
      const parsed = z.object({ text: z.string() }).safeParse(data);
      return parsed.success ? { event: "token", text: parsed.data.text } : null;
    }
    if (eventName === "done") {
      const parsed = z.object({ usage: usageSchema }).safeParse(data);
      return parsed.success
        ? { event: "done", usage: parsed.data.usage }
        : null;
    }
    if (eventName === "error") {
      const parsed = z.object({ message: z.string() }).safeParse(data);
      if (parsed.success)
        throw new AiServiceError("LLM_ERROR", parsed.data.message);
    }
    return null;
  }

  /** True when the AI service answers /health in time. Never throws. */
  async isHealthy(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.AI_SERVICE_URL}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
