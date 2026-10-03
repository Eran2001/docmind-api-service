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
} from "vitest";

import { configureApp, createAdapter } from "../src/app.setup";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { JwtAuthGuard } from "../src/common/guards/jwt-auth.guard";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { ConfigModule } from "../src/config/config.module";
import { loadEnv } from "../src/config/env.schema";
import { DatabaseModule, PG_POOL } from "../src/database/database.module";
import { StorageModule } from "../src/integrations/storage/storage.module";
import { AuthModule } from "../src/modules/auth/auth.module";
import { CollectionsModule } from "../src/modules/collections/collections.module";
import { FeedbackModule } from "../src/modules/feedback/feedback.module";

const config = loadEnv(process.env);

describe.skipIf(!inject("dbReady"))("rated answers (real Postgres)", () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        StorageModule,
        AuthModule,
        CollectionsModule,
        FeedbackModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
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
  });

  const register = async (email: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { name: "Rater", email, password: "password123" },
    });
    return {
      token: res.json().data.accessToken as string,
      id: res.json().data.user.resourceId as string,
    };
  };
  const newCollection = async (token: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${token}` },
        payload: { name: "Handbook" },
      })
    ).json().resourceId as string;
  const exchange = async (
    userId: string,
    collectionId: string,
    conversationId: string,
    question: string,
    answer: string,
    secondsAgo: number,
  ) => {
    await pool.query(
      "INSERT INTO messages (conversation_id, role, content, status, created_at) VALUES ($1, 'user', $2, 'complete', now() - ($3 || ' seconds')::interval)",
      [conversationId, question, String(secondsAgo + 1)],
    );
    const assistant = await pool.query<{ id: string }>(
      "INSERT INTO messages (conversation_id, role, content, status, created_at) VALUES ($1, 'assistant', $2, 'complete', now() - ($3 || ' seconds')::interval) RETURNING id",
      [conversationId, answer, String(secondsAgo)],
    );
    return assistant.rows[0]!.id;
  };
  const rate = (
    userId: string,
    messageId: string,
    rating: 1 | -1,
    comment: string | null = null,
  ) =>
    pool.query(
      "INSERT INTO message_feedback (message_id, user_id, rating, comment) VALUES ($1, $2, $3, $4)",
      [messageId, userId, rating, comment],
    );
  const list = (token: string, collectionId: string, query = "") =>
    app.inject({
      method: "GET",
      url: `/api/v1/collections/${collectionId}/feedback${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("lists the thumbs-down answers with the question that was asked, newest rating first", async () => {
    const user = await register("rater@test.com");
    const collectionId = await newCollection(user.token);
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations (collection_id, user_id) VALUES ($1, $2) RETURNING id",
      [collectionId, user.id],
    );
    const conversationId = conversation.rows[0]!.id;
    const first = await exchange(
      user.id,
      collectionId,
      conversationId,
      "How many PTO days?",
      "I think 20.",
      300,
    );
    const second = await exchange(
      user.id,
      collectionId,
      conversationId,
      "What is the notice period?",
      "Two weeks.",
      200,
    );
    const liked = await exchange(
      user.id,
      collectionId,
      conversationId,
      "Where is HR?",
      "Level 4.",
      100,
    );
    await rate(user.id, first, -1, "It is 25 days");
    await rate(user.id, second, -1);
    await rate(user.id, liked, 1);

    const res = await list(user.token, collectionId);

    expect(res.statusCode).toBe(200);
    const items = res.json().data.result;
    expect(items.map((i: { question: string }) => i.question)).toEqual([
      "What is the notice period?",
      "How many PTO days?",
    ]);
    expect(items[1]).toMatchObject({
      resourceId: first,
      conversationId,
      answer: "I think 20.",
      comment: "It is 25 days",
    });
    expect(items[0].comment).toBeNull();

    const liked_ = (await list(user.token, collectionId, "?rating=1")).json()
      .data.result;
    expect(liked_.map((i: { question: string }) => i.question)).toEqual([
      "Where is HR?",
    ]);
  });

  it("only shows your own ratings in a collection you own, and validates the query", async () => {
    const owner = await register("owner@test.com");
    const other = await register("other@test.com");
    const collectionId = await newCollection(owner.token);
    const conversation = await pool.query<{ id: string }>(
      "INSERT INTO conversations (collection_id, user_id) VALUES ($1, $2) RETURNING id",
      [collectionId, owner.id],
    );
    const message = await exchange(
      owner.id,
      collectionId,
      conversation.rows[0]!.id,
      "Q?",
      "A.",
      10,
    );
    await rate(owner.id, message, -1);

    expect((await list(other.token, collectionId)).statusCode).toBe(404);
    expect(
      (await list(owner.token, collectionId, "?rating=0")).statusCode,
    ).toBe(400);
    expect(
      (await list(owner.token, collectionId, "?limit=500")).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/collections/${collectionId}/feedback`,
        })
      ).statusCode,
    ).toBe(401);
  });
});
