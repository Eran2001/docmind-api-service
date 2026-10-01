import { afterEach, describe, expect, it, vi } from "vitest";

import { AiClient } from "./ai.client";
import type { Env } from "../../config/env.schema";

const config = {
  AI_SERVICE_URL: "http://ai.test",
  INTERNAL_API_KEY: "test-secret",
} as Env;

afterEach(() => vi.unstubAllGlobals());

describe("AiClient answer stream", () => {
  it("parses token and done events and sends the internal key", async () => {
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'event: token\ndata: {"text":"Hello "}\n\nevent: token\ndata: {"text":"[1]"}\n\nevent: done\ndata: {"usage":{"model":"llama3.2","input_tokens":10,"output_tokens":2,"latency_ms":4}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fakeFetch);
    const client = new AiClient(config);
    const events = [];
    for await (const event of client.answerStream(
      { question: "Question?", history: [], chunks: [] },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { event: "token", text: "Hello " },
      { event: "token", text: "[1]" },
      {
        event: "done",
        usage: {
          model: "llama3.2",
          input_tokens: 10,
          output_tokens: 2,
          latency_ms: 4,
        },
      },
    ]);
    expect(fakeFetch).toHaveBeenCalledWith(
      "http://ai.test/answer",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Internal-Key": "test-secret",
          Accept: "text/event-stream",
        }),
      }),
    );
  });

  it("turns AI SSE error events into typed service errors", async () => {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('event: error\ndata: {"message":"LLM unavailable"}\n\n', {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fakeFetch);
    const client = new AiClient(config);

    await expect(async () => {
      for await (const _event of client.answerStream(
        { question: "Question?", history: [], chunks: [] },
        new AbortController().signal,
      )) {
        // Consume until the server's error frame.
      }
    }).rejects.toMatchObject({ code: "LLM_ERROR", message: "LLM unavailable" });
  });

  it("requires a done event before considering a stream complete", async () => {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('event: token\ndata: {"text":"partial"}\n\n', {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fakeFetch);
    const client = new AiClient(config);

    await expect(async () => {
      for await (const _event of client.answerStream(
        { question: "Question?", history: [], chunks: [] },
        new AbortController().signal,
      )) {
        // The stream must finish with done before the API persists an answer.
      }
    }).rejects.toMatchObject({ code: "AI_STREAM_FAILED" });
  });
});

describe("AiClient document ingest", () => {
  it("accepts the file-ingest response shape, which has no title field", async () => {
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          page_count: null,
          chunks: [
            {
              index: 0,
              content: "A readable document chunk.",
              page_number: null,
              heading: null,
              token_count: 5,
              embedding: Array.from({ length: 1536 }, () => 0.1),
            },
          ],
          usage: {
            model: "text-embedding-3-small",
            input_tokens: 5,
            output_tokens: 0,
            latency_ms: 3,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fakeFetch);
    const client = new AiClient(config);

    const result = await client.ingestFile(
      Buffer.from("text"),
      "text/plain",
      "note.txt",
    );

    expect(result.chunks).toHaveLength(1);
    expect(result.title).toBeUndefined();
    expect(result.usage.model).toBe("text-embedding-3-small");
  });
});
