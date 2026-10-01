import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiClient,
  type AiAnswerEvent,
  type AiUsage,
} from "../../integrations/ai/ai.client";
import type { ConversationRow } from "../conversations/conversations.repository";
import { ConversationsService } from "../conversations/conversations.service";
import { ChatService, type ChatSseEvent } from "./chat.service";
import {
  RetrievalRepository,
  type RetrievedChunk,
} from "./retrieval.repository";

const conversationId = "00000000-0000-4000-8000-000000000101";
const collectionId = "00000000-0000-4000-8000-000000000102";
const userId = "00000000-0000-4000-8000-000000000103";
const userMessageId = "00000000-0000-4000-8000-000000000104";
const assistantMessageId = "00000000-0000-4000-8000-000000000105";

const usage: AiUsage = {
  model: "llama3.2",
  input_tokens: 20,
  output_tokens: 8,
  latency_ms: 15,
};

const row = {
  id: conversationId,
  collectionId,
  userId,
  title: "New chat",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
} as ConversationRow;

const chunk: RetrievedChunk = {
  id: "00000000-0000-4000-8000-000000000106",
  content: "Employees may return purchases within thirty days of delivery.",
  pageNumber: 4,
  heading: "Returns",
  documentId: "00000000-0000-4000-8000-000000000107",
  documentTitle: "Returns.pdf",
  score: 0.03,
};

describe("ChatService", () => {
  let conversations: {
    requireOwned: ReturnType<typeof vi.fn>;
    history: ReturnType<typeof vi.fn>;
    createMessagePair: ReturnType<typeof vi.fn>;
    completeAssistant: ReturnType<typeof vi.fn>;
    appendPartial: ReturnType<typeof vi.fn>;
    updateTitle: ReturnType<typeof vi.fn>;
    saveFeedback: ReturnType<typeof vi.fn>;
  };
  let retrieval: {
    readyDocumentCount: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
  };
  let ai: {
    rewriteQuery: ReturnType<typeof vi.fn>;
    embed: ReturnType<typeof vi.fn>;
    answerStream: ReturnType<typeof vi.fn>;
    generateTitle: ReturnType<typeof vi.fn>;
  };
  let chat: ChatService;

  beforeEach(() => {
    conversations = {
      requireOwned: vi.fn().mockResolvedValue(row),
      history: vi.fn().mockResolvedValue([]),
      createMessagePair: vi
        .fn()
        .mockResolvedValue({ userMessageId, assistantMessageId }),
      completeAssistant: vi.fn().mockResolvedValue(undefined),
      appendPartial: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
      saveFeedback: vi.fn().mockResolvedValue(undefined),
    };
    retrieval = {
      readyDocumentCount: vi.fn().mockResolvedValue(1),
      search: vi.fn().mockResolvedValue([chunk]),
    };
    ai = {
      rewriteQuery: vi
        .fn()
        .mockResolvedValue({ query: "return window", usage }),
      embed: vi
        .fn()
        .mockResolvedValue({
          embeddings: [Array.from({ length: 1536 }, () => 0.2)],
          usage,
        }),
      answerStream: vi.fn(async function* (): AsyncGenerator<AiAnswerEvent> {
        yield { event: "token", text: "You have thirty days [1] [99]." };
        yield { event: "done", usage };
      }),
      generateTitle: vi
        .fn()
        .mockResolvedValue({ title: "Return policy", usage }),
    };
    chat = new ChatService(
      conversations as unknown as ConversationsService,
      retrieval as unknown as RetrievalRepository,
      ai as unknown as AiClient,
    );
  });

  it("answers from retrieved chunks, strips invalid citations, saves usage and emits done", async () => {
    const events: ChatSseEvent[] = [];
    await chat.sendMessage(
      userId,
      conversationId,
      "How long can I return it?",
      new AbortController().signal,
      (e) => events.push(e),
    );

    expect(ai.rewriteQuery).not.toHaveBeenCalled();
    expect(ai.embed).toHaveBeenCalledWith(
      ["How long can I return it?"],
      expect.any(AbortSignal),
    );
    expect(retrieval.search).toHaveBeenCalledWith(
      collectionId,
      expect.any(Array),
      "How long can I return it?",
    );
    expect(conversations.completeAssistant).toHaveBeenCalledWith(
      userId,
      conversationId,
      assistantMessageId,
      expect.objectContaining({
        content: "You have thirty days [1].",
        citations: [
          expect.objectContaining({
            marker: 1,
            documentTitle: "Returns.pdf",
            pageNumber: 4,
          }),
        ],
        usage: expect.arrayContaining([
          expect.objectContaining({ kind: "embed" }),
          expect.objectContaining({ kind: "answer" }),
        ]),
      }),
    );
    expect(events.map((e) => e.event)).toEqual([
      "meta",
      "status",
      "status",
      "token",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      event: "done",
      data: {
        citations: [expect.objectContaining({ marker: 1 })],
        retrieval: { documents: 1, passages: 1 },
      },
    });
  });

  it("rewrites follow-up questions using prior messages before embedding", async () => {
    conversations.history.mockResolvedValue([
      { role: "user", content: "What is the policy?" },
      { role: "assistant", content: "Returns are allowed [1]." },
    ]);
    const events: ChatSseEvent[] = [];

    await chat.sendMessage(
      userId,
      conversationId,
      "and for sale items?",
      new AbortController().signal,
      (e) => events.push(e),
    );

    expect(ai.rewriteQuery).toHaveBeenCalledWith(
      [
        { role: "user", content: "What is the policy?" },
        { role: "assistant", content: "Returns are allowed [1]." },
      ],
      "and for sale items?",
      expect.any(AbortSignal),
    );
    expect(ai.embed).toHaveBeenCalledWith(
      ["return window"],
      expect.any(AbortSignal),
    );
  });

  it("answers collections without ready documents without model calls", async () => {
    retrieval.readyDocumentCount.mockResolvedValue(0);
    const events: ChatSseEvent[] = [];

    await chat.sendMessage(
      userId,
      conversationId,
      "What is in here?",
      new AbortController().signal,
      (e) => events.push(e),
    );

    expect(ai.rewriteQuery).not.toHaveBeenCalled();
    expect(ai.embed).not.toHaveBeenCalled();
    expect(ai.answerStream).not.toHaveBeenCalled();
    expect(conversations.completeAssistant).toHaveBeenCalledWith(
      userId,
      conversationId,
      assistantMessageId,
      expect.objectContaining({
        content: "I couldn't find anything in your documents about that.",
        usage: [],
      }),
    );
    expect(events.filter((e) => e.event === "token")).toEqual([
      {
        event: "token",
        data: {
          text: "I couldn't find anything in your documents about that.",
        },
      },
    ]);
  });

  it("persists partial output and emits a safe error if the model fails", async () => {
    ai.answerStream.mockImplementation(
      async function* (): AsyncGenerator<AiAnswerEvent> {
        yield { event: "token", text: "Partial answer" };
        throw new Error("secret upstream details");
      },
    );
    const events: ChatSseEvent[] = [];

    await chat.sendMessage(
      userId,
      conversationId,
      "Question?",
      new AbortController().signal,
      (e) => events.push(e),
    );

    expect(conversations.appendPartial).toHaveBeenCalledWith(
      userId,
      conversationId,
      assistantMessageId,
      "Partial answer",
      expect.any(Number),
      expect.arrayContaining([expect.objectContaining({ kind: "embed" })]),
    );
    expect(events.at(-1)).toEqual({
      event: "error",
      data: {
        code: "AiServiceFailed",
        message: "I couldn't generate an answer. Please try again.",
      },
    });
  });
});
