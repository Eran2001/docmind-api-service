import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

import { configureApp, createAdapter } from "../src/app.setup";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { JwtAuthGuard } from "../src/common/guards/jwt-auth.guard";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { ConfigModule } from "../src/config/config.module";
import { DatabaseModule, PG_POOL } from "../src/database/database.module";
import { AiClient, type AiAnswerEvent } from "../src/integrations/ai/ai.client";
import { StorageModule } from "../src/integrations/storage/storage.module";
import { AuthModule } from "../src/modules/auth/auth.module";
import { ChatModule } from "../src/modules/chat/chat.module";
import { RetrievalRepository } from "../src/modules/chat/retrieval.repository";
import { CollectionsModule } from "../src/modules/collections/collections.module";
import { ConversationsModule } from "../src/modules/conversations/conversations.module";
import { loadEnv } from "../src/config/env.schema";

const config = loadEnv(process.env);
const documentId = "00000000-0000-4000-8000-000000000302";
const chunkId = "00000000-0000-4000-8000-000000000303";
const vector = Array.from({ length: 1536 }, (_, index) =>
  index === 0 ? 1 : 0,
);
const usage = {
  model: "llama3.2",
  input_tokens: 18,
  output_tokens: 7,
  latency_ms: 12,
};

describe.skipIf(!inject("dbReady"))(
  "chat flow (real Postgres, mocked AI)",
  () => {
    let app: NestFastifyApplication;
    let pool: Pool;
    let ai: {
      embed: ReturnType<typeof vi.fn>;
      rewriteQuery: ReturnType<typeof vi.fn>;
      answerStream: ReturnType<typeof vi.fn>;
      generateTitle: ReturnType<typeof vi.fn>;
    };
    let retrieval: {
      readyDocumentCount: ReturnType<typeof vi.fn>;
      search: ReturnType<typeof vi.fn>;
    };

    beforeAll(async () => {
      ai = {
        embed: vi.fn(),
        rewriteQuery: vi.fn(),
        answerStream: vi.fn(),
        generateTitle: vi.fn(),
      };
      retrieval = { readyDocumentCount: vi.fn(), search: vi.fn() };
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule,
          DatabaseModule,
          StorageModule,
          AuthModule,
          CollectionsModule,
          ConversationsModule,
          ChatModule,
        ],
        providers: [
          { provide: APP_FILTER, useClass: AllExceptionsFilter },
          { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
          { provide: APP_GUARD, useClass: JwtAuthGuard },
        ],
      })
        .overrideProvider(AiClient)
        .useValue(ai)
        .overrideProvider(RetrievalRepository)
        .useValue(retrieval)
        .compile();
      app = module.createNestApplication<NestFastifyApplication>(
        createAdapter(),
        { logger: false },
      );
      await configureApp(app, config);
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      pool = module.get<Pool>(PG_POOL);
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE users CASCADE");
      ai.embed.mockReset().mockResolvedValue({
        embeddings: [vector],
        usage: { ...usage, model: "text-embedding-3-small", output_tokens: 0 },
      });
      ai.rewriteQuery
        .mockReset()
        .mockResolvedValue({ query: "return window", usage });
      ai.answerStream
        .mockReset()
        .mockImplementation(async function* (): AsyncGenerator<AiAnswerEvent> {
          yield {
            event: "token",
            text: "You may return it within 30 days [1].",
          };
          yield { event: "done", usage };
        });
      ai.generateTitle
        .mockReset()
        .mockResolvedValue({ title: "Return window", usage });
      retrieval.readyDocumentCount.mockReset().mockResolvedValue(1);
      retrieval.search.mockReset().mockResolvedValue([
        {
          id: chunkId,
          content: "Items may be returned within thirty days.",
          pageNumber: 3,
          heading: "Returns",
          documentId,
          documentTitle: "Handbook.pdf",
          score: 0.03,
        },
      ]);
    });

    it("creates a conversation, streams a cited answer, and persists messages and usage", async () => {
      const registration = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          name: "Chat Tester",
          email: "chat@test.com",
          password: "password123",
        },
      });
      const token = registration.json().data.accessToken as string;
      const createdCollection = await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Handbook" },
      });
      const collectionId = createdCollection.json().resourceId as string;
      const createdConversation = await app.inject({
        method: "POST",
        url: `/api/v1/collections/${collectionId}/conversations`,
        headers: { authorization: `Bearer ${token}` },
      });
      const conversationId = createdConversation.json().resourceId as string;

      expect(createdConversation.statusCode).toBe(201);
      expect(createdConversation.json().data).toEqual({ result: true });

      const streamed = await app.inject({
        method: "POST",
        url: `/api/v1/conversations/${conversationId}/messages`,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
          origin: "http://localhost:3000",
        },
        payload: { content: "How long do I have to return this?" },
      });

      expect(streamed.statusCode).toBe(200);
      expect(streamed.headers["content-type"]).toContain("text/event-stream");
      expect(streamed.headers["x-request-id"]).toBeTruthy();
      expect(streamed.headers["access-control-allow-origin"]).toBe(
        "http://localhost:3000",
      );
      expect(streamed.headers["access-control-allow-credentials"]).toBe("true");
      expect(streamed.body).toContain('event: meta\ndata: {"userMessageId":');
      expect(streamed.body).toContain(
        'event: status\ndata: {"stage":"searching"}',
      );
      expect(streamed.body).toContain(
        'event: token\ndata: {"text":"You may return it within 30 days [1]."}',
      );
      expect(streamed.body).toContain('event: done\ndata: {"citations":');

      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const messages = detail.json().data.messages as {
        resourceId: string;
        role: string;
        content: string;
        status: string;
        citations: { marker: number; chunkId: string; pageNumber: number }[];
        usage: { inputTokens: number; outputTokens: number } | null;
      }[];

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: "How long do I have to return this?",
        status: "complete",
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        content: "You may return it within 30 days [1].",
        status: "complete",
        citations: [{ marker: 1, chunkId, pageNumber: 3 }],
        usage: { inputTokens: 36, outputTokens: 7 },
      });
      expect(ai.embed).toHaveBeenCalledWith(
        ["How long do I have to return this?"],
        expect.any(AbortSignal),
      );
      expect(ai.answerStream).toHaveBeenCalledOnce();

      const feedback = await app.inject({
        method: "PUT",
        url: `/api/v1/messages/${messages[1]?.resourceId}/feedback`,
        headers: { authorization: `Bearer ${token}` },
        payload: { rating: 1 },
      });
      expect(feedback.statusCode).toBe(200);
      const refreshed = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(refreshed.json().data.messages[1].feedback).toEqual({
        rating: 1,
        comment: null,
      });
    });

    it("returns 404 for conversations owned by a different user", async () => {
      const registration = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          name: "Owner",
          email: "owner@test.com",
          password: "password123",
        },
      });
      const token = registration.json().data.accessToken as string;
      const collection = await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Private" },
      });
      const conversation = await app.inject({
        method: "POST",
        url: `/api/v1/collections/${collection.json().resourceId}/conversations`,
        headers: { authorization: `Bearer ${token}` },
      });
      const outsider = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          name: "Other",
          email: "other@test.com",
          password: "password123",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/${conversation.json().resourceId}`,
        headers: {
          authorization: `Bearer ${outsider.json().data.accessToken}`,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("NotFound");
    });
  },
);
