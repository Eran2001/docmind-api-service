import { getQueueToken } from "@nestjs/bullmq";
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
import { QUEUES } from "../src/config/constants";
import { loadEnv } from "../src/config/env.schema";
import { DatabaseModule, PG_POOL } from "../src/database/database.module";
import { StorageModule } from "../src/integrations/storage/storage.module";
import { AuthModule } from "../src/modules/auth/auth.module";
import { CollectionsModule } from "../src/modules/collections/collections.module";
import { EvalsModule } from "../src/modules/evals/evals.module";

const config = loadEnv(process.env);

describe.skipIf(!inject("dbReady"))(
  "eval routes (real Postgres, queue fake)",
  () => {
    let app: NestFastifyApplication;
    let pool: Pool;
    const evalQueue = { name: QUEUES.EVALS, add: vi.fn(), on: vi.fn() };

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule,
          DatabaseModule,
          StorageModule,
          AuthModule,
          CollectionsModule,
          EvalsModule,
        ],
        providers: [
          { provide: getQueueToken(QUEUES.EVALS), useValue: evalQueue },
          { provide: APP_FILTER, useClass: AllExceptionsFilter },
          { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
          { provide: APP_GUARD, useClass: JwtAuthGuard },
        ],
      })
        .overrideProvider(getQueueToken(QUEUES.EVALS))
        .useValue(evalQueue)
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
      evalQueue.add.mockReset().mockResolvedValue({});
    });

    const register = async (email: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { name: "Eval tester", email, password: "password123" },
      });
      return {
        token: res.json().data.accessToken as string,
        id: res.json().data.user.resourceId as string,
      };
    };

    it("creates an owned eval set, validates expected-doc ownership, and queues a run", async () => {
      const owner = await register("eval-owner@test.com");
      const outsider = await register("eval-outsider@test.com");
      const collection = await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { name: "Handbook" },
      });
      const collectionId = collection.json().resourceId as string;

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/evals/sets",
        headers: { authorization: `Bearer ${owner.token}` },
        payload: {
          name: "Returns check",
          collectionId,
          description: "Check return rules",
        },
      });
      const setId = created.json().resourceId as string;
      expect(created.statusCode).toBe(201);
      expect(created.json().data).toEqual({ result: true });

      const foreignCollection = await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${outsider.token}` },
        payload: { name: "Other" },
      });
      const foreignDoc = await pool.query<{ id: string }>(
        "INSERT INTO documents (collection_id, user_id, source_type, title) VALUES ($1, $2, 'file', 'other.txt') RETURNING id",
        [foreignCollection.json().resourceId, outsider.id],
      );

      const invalidExpectedDoc = await app.inject({
        method: "POST",
        url: `/api/v1/evals/sets/${setId}/questions`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: {
          question: "How long?",
          expectedAnswer: "Thirty days",
          expectedDocumentId: foreignDoc.rows[0]?.id,
        },
      });
      expect(invalidExpectedDoc.statusCode).toBe(404);

      const question = await app.inject({
        method: "POST",
        url: `/api/v1/evals/sets/${setId}/questions`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { question: "How long?", expectedAnswer: "Thirty days" },
      });
      expect(question.statusCode).toBe(201);
      expect(question.json().resourceId).toBeTruthy();

      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/evals/sets/${setId}`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(detail.json().data).toMatchObject({
        resourceId: setId,
        name: "Returns check",
        description: "Check return rules",
        collectionName: "Handbook",
        questionCount: 1,
        questions: [
          {
            resourceId: question.json().resourceId,
            question: "How long?",
            expectedAnswer: "Thirty days",
          },
        ],
        runs: [],
      });

      const run = await app.inject({
        method: "POST",
        url: `/api/v1/evals/sets/${setId}/runs`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: {},
      });
      expect(run.statusCode).toBe(202);
      expect(run.json().data).toEqual({ result: true });
      expect(evalQueue.add).toHaveBeenCalledWith(
        "run-eval",
        { runId: run.json().resourceId },
        expect.any(Object),
      );

      const runDetail = await app.inject({
        method: "GET",
        url: `/api/v1/evals/runs/${run.json().resourceId}`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(runDetail.json().data).toMatchObject({
        resourceId: run.json().resourceId,
        evalSetId: setId,
        status: "queued",
        number: 1,
        progress: { done: 0, total: 1 },
        results: [],
      });
    });

    it("rejects empty sets for run and hides sets from other users", async () => {
      const owner = await register("empty-eval@test.com");
      const outsider = await register("eval-other@test.com");
      const collection = await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { name: "Empty eval" },
      });
      const set = await app.inject({
        method: "POST",
        url: "/api/v1/evals/sets",
        headers: { authorization: `Bearer ${owner.token}` },
        payload: {
          name: "No questions",
          collectionId: collection.json().resourceId,
        },
      });
      const setId = set.json().resourceId as string;

      const run = await app.inject({
        method: "POST",
        url: `/api/v1/evals/sets/${setId}/runs`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: {},
      });
      expect(run.statusCode).toBe(422);
      expect(evalQueue.add).not.toHaveBeenCalled();

      const hidden = await app.inject({
        method: "GET",
        url: `/api/v1/evals/sets/${setId}`,
        headers: { authorization: `Bearer ${outsider.token}` },
      });
      expect(hidden.statusCode).toBe(404);
    });
  },
);
