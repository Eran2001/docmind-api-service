import { getQueueToken } from "@nestjs/bullmq";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import { DemoRestrictionGuard } from "../src/common/guards/demo-restriction.guard";
import { JwtAuthGuard } from "../src/common/guards/jwt-auth.guard";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { ConfigModule } from "../src/config/config.module";
import { DEMO, QUEUES } from "../src/config/constants";
import { loadEnv } from "../src/config/env.schema";
import { DatabaseModule, PG_POOL } from "../src/database/database.module";
import { StorageModule } from "../src/integrations/storage/storage.module";
import { AuthModule } from "../src/modules/auth/auth.module";
import { CollectionsModule } from "../src/modules/collections/collections.module";
import { DemoLimitsService } from "../src/modules/demo/demo-limits.service";
import { DemoModule } from "../src/modules/demo/demo.module";
import { DemoService } from "../src/modules/demo/demo.service";
import { DocumentsController } from "../src/modules/documents/documents.controller";
import { DocumentsRepository } from "../src/modules/documents/documents.repository";
import { DocumentsService } from "../src/modules/documents/documents.service";
import { EvalsModule } from "../src/modules/evals/evals.module";
import { DEMO_COLLECTION } from "../src/seed-data";

const config = loadEnv(process.env);
const STORAGE = resolve(config.STORAGE_DIR);

describe.skipIf(!inject("dbReady"))(
  "demo sandbox (real Postgres and disk)",
  () => {
    let app: NestFastifyApplication;
    let pool: Pool;
    let limits: DemoLimitsService;
    let demo: DemoService;
    const queue = { name: QUEUES.INGEST, add: vi.fn(), on: vi.fn() };
    const evalQueue = { name: QUEUES.EVALS, add: vi.fn(), on: vi.fn() };

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule,
          DatabaseModule,
          StorageModule,
          AuthModule,
          CollectionsModule,
          DemoModule,
          EvalsModule,
        ],
        controllers: [DocumentsController],
        providers: [
          DocumentsRepository,
          DocumentsService,
          { provide: APP_FILTER, useClass: AllExceptionsFilter },
          { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
          { provide: APP_GUARD, useClass: JwtAuthGuard },
          { provide: APP_GUARD, useClass: DemoRestrictionGuard },
        ],
      })
        .useMocker((token) =>
          token === getQueueToken(QUEUES.INGEST)
            ? queue
            : token === getQueueToken(QUEUES.EVALS)
              ? evalQueue
              : undefined,
        )
        .compile();
      app = module.createNestApplication<NestFastifyApplication>(
        createAdapter(),
        { logger: false },
      );
      await configureApp(app, config);
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      pool = module.get<Pool>(PG_POOL);
      limits = module.get(DemoLimitsService);
      demo = module.get(DemoService);
    });
    afterAll(async () => {
      await app.close();
      await rm(STORAGE, { recursive: true, force: true });
    });
    beforeEach(async () => {
      await pool.query("TRUNCATE users CASCADE");
      await rm(STORAGE, { recursive: true, force: true });
      queue.add.mockReset().mockResolvedValue({});
    });

    /** What `npm run db:seed` leaves behind: the template account with a ready document, its chunk and an eval set. */
    const seedTemplate = async () => {
      const user = await pool.query<{ id: string }>(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, 'Template', 'x') RETURNING id",
        [DEMO.TEMPLATE_EMAIL],
      );
      const userId = user.rows[0]!.id;
      const collection = await pool.query<{ id: string }>(
        "INSERT INTO collections (user_id, name, description) VALUES ($1, $2, 'sample') RETURNING id",
        [userId, DEMO_COLLECTION.name],
      );
      const collectionId = collection.rows[0]!.id;
      const doc = await pool.query<{ id: string }>(
        `INSERT INTO documents (collection_id, user_id, source_type, title, original_filename, mime_type, storage_path, size_bytes, status, chunk_count, content_hash)
         VALUES ($1, $2, 'file', 'handbook.md', 'handbook.md', 'text/markdown', $3, 12, 'ready', 1, 'hash-1') RETURNING id`,
        [collectionId, userId, `${userId}/template-doc.md`],
      );
      const docId = doc.rows[0]!.id;
      mkdirSync(join(STORAGE, userId), { recursive: true });
      writeFileSync(join(STORAGE, userId, "template-doc.md"), "# Handbook");
      await pool.query(
        `INSERT INTO chunks (document_id, collection_id, chunk_index, content, token_count, embedding)
         VALUES ($1, $2, 0, 'Employees get 25 days of PTO.', 8, array_fill(0.1::real, ARRAY[1536])::vector)`,
        [docId, collectionId],
      );
      const set = await pool.query<{ id: string }>(
        "INSERT INTO eval_sets (user_id, collection_id, name) VALUES ($1, $2, 'Basics') RETURNING id",
        [userId, collectionId],
      );
      await pool.query(
        "INSERT INTO eval_questions (eval_set_id, question, expected_answer, expected_document_id) VALUES ($1, 'PTO?', '25 days', $2)",
        [set.rows[0]!.id, docId],
      );
      return { userId, collectionId, docId };
    };

    const startDemo = async () => {
      const { session } = await demo.start();
      return { token: session.accessToken, user: session.user };
    };
    const call = (
      token: string,
      method: "GET" | "POST" | "PATCH" | "DELETE",
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${token}` },
        payload: payload as Record<string, unknown> | undefined,
      });
    const registerNormal = async (email: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { name: "Normal", email, password: "password123" },
      });
      return res.json().data.accessToken as string;
    };

    it("copies the sample collection, documents with chunks, files and the eval set into a private account", async () => {
      const template = await seedTemplate();

      const { token, user } = await startDemo();

      expect(user.email).toMatch(/^demo-.+@demo\.docmind\.invalid$/);
      expect(user.demo).toMatchObject({
        questionsLeft: DEMO.QUESTIONS,
        uploadsLeft: DEMO.UPLOADS,
      });
      const collections = (await call(token, "GET", "/collections")).json().data
        .result;
      expect(collections).toHaveLength(1);
      expect(collections[0]).toMatchObject({
        name: DEMO_COLLECTION.name,
        documentCount: 1,
      });
      expect(collections[0].resourceId).not.toBe(template.collectionId);

      const docs = (
        await call(
          token,
          "GET",
          `/collections/${collections[0].resourceId}/documents`,
        )
      ).json().data.result;
      expect(docs[0]).toMatchObject({ title: "handbook.md", status: "ready" });
      expect(docs[0].resourceId).not.toBe(template.docId);

      const chunks = await pool.query(
        "SELECT count(*)::int AS n FROM chunks WHERE document_id = $1",
        [docs[0].resourceId],
      );
      expect(chunks.rows[0].n).toBe(1);
      const stored = await pool.query<{ storage_path: string }>(
        "SELECT storage_path FROM documents WHERE id = $1",
        [docs[0].resourceId],
      );
      expect(existsSync(join(STORAGE, stored.rows[0]!.storage_path))).toBe(
        true,
      );
      expect(
        stored.rows[0]!.storage_path.startsWith(`${user.resourceId}/`),
      ).toBe(true);

      const sets = (await call(token, "GET", "/evals/sets")).json().data.result;
      expect(sets).toHaveLength(1);
      const setDetail = (
        await call(token, "GET", `/evals/sets/${sets[0].resourceId}`)
      ).json().data;
      expect(setDetail.questions[0].expectedDocumentId).toBe(
        docs[0].resourceId,
      );

      // The template is untouched, and a second visitor gets their own copy.
      const second = await startDemo();
      const others = (await call(second.token, "GET", "/collections")).json()
        .data.result;
      expect(others[0].resourceId).not.toBe(collections[0].resourceId);
      const count = await pool.query(
        "SELECT count(*)::int AS n FROM documents WHERE collection_id = $1",
        [template.collectionId],
      );
      expect(count.rows[0].n).toBe(1);
    });

    it("says the demo isn't set up when the sample data is missing, and when it is busy", async () => {
      await expect(demo.start()).rejects.toMatchObject({
        code: "ServiceUnavailable",
      });

      await seedTemplate();
      await pool.query(
        `INSERT INTO users (email, name, password_hash, is_demo)
         SELECT 'busy-' || n || '@demo.docmind.invalid', 'x', 'x', true FROM generate_series(1, $1) n`,
        [DEMO.MAX_ACTIVE],
      );
      await expect(demo.start()).rejects.toMatchObject({
        code: "ServiceUnavailable",
        message: expect.stringContaining("busy"),
      });
    });

    it("blocks changing the account, creating or deleting collections and running evals for a demo user, but not for a normal user", async () => {
      await seedTemplate();
      const { token } = await startDemo();
      const collectionId = (await call(token, "GET", "/collections")).json()
        .data.result[0].resourceId as string;

      for (const [method, url, payload] of [
        ["PATCH", "/auth/me", { name: "Hacker", email: "h@x.com" }],
        ["DELETE", "/auth/me", undefined],
        ["POST", "/collections", { name: "More" }],
        ["DELETE", `/collections/${collectionId}`, undefined],
        ["POST", "/evals/sets", { name: "S", collectionId }],
      ] as const) {
        const res = await call(token, method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().code).toBe("DemoRestricted");
      }
      // Reading and chatting are fine.
      expect((await call(token, "GET", "/auth/me")).statusCode).toBe(200);
      expect((await call(token, "GET", "/collections")).statusCode).toBe(200);

      const normal = await registerNormal("normal@test.com");
      expect(
        (await call(normal, "POST", "/collections", { name: "Mine" }))
          .statusCode,
      ).toBe(201);
    });

    it("allows one upload, hands the unit back when the file is rejected, and then answers DemoLimitReached", async () => {
      await seedTemplate();
      const { token } = await startDemo();
      const collectionId = (await call(token, "GET", "/collections")).json()
        .data.result[0].resourceId as string;
      const multipart = (filename: string, content: Buffer) => {
        const boundary = `----demo${Math.random().toString(16).slice(2)}`;
        return {
          payload: Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
            ),
            content,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
        };
      };
      const upload = (filename: string, content: Buffer) =>
        app.inject({
          method: "POST",
          url: `/api/v1/collections/${collectionId}/documents`,
          ...multipart(filename, content),
        });
      const uploadsLeft = async () =>
        (await call(token, "GET", "/auth/me")).json().data.user.demo
          .uploadsLeft as number;

      const bad = await upload("bad.pdf", Buffer.from("not a pdf"));
      expect(bad.statusCode).toBe(400);
      expect(await uploadsLeft()).toBe(1); // refunded

      const good = await upload("notes.md", Buffer.from("# Notes\nhello"));
      expect(good.statusCode).toBe(202);
      expect(await uploadsLeft()).toBe(0);

      const second = await upload("more.md", Buffer.from("# More\nworld"));
      expect(second.statusCode).toBe(403);
      expect(second.json().code).toBe("DemoLimitReached");
    });

    it("gives exactly DEMO.QUESTIONS questions, even when they arrive at the same time", async () => {
      await seedTemplate();
      const { user } = await startDemo();

      const results = await Promise.allSettled(
        Array.from({ length: DEMO.QUESTIONS + 3 }, () =>
          limits.reserveQuestion(user.resourceId),
        ),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(
        DEMO.QUESTIONS,
      );
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(3);
      expect(rejected[0]).toMatchObject({
        reason: { code: "DemoLimitReached" },
      });

      await limits.refund(user.resourceId, "question");
      await expect(
        limits.reserveQuestion(user.resourceId),
      ).resolves.toBeUndefined();
    });

    it("only counts demo accounts (the controllers skip the limits for normal tokens)", async () => {
      const normal = await pool.query<{ id: string }>(
        "INSERT INTO users (email, name, password_hash) VALUES ('n@test.com', 'N', 'x') RETURNING id",
      );
      await expect(
        limits.reserveQuestion(normal.rows[0]!.id),
      ).rejects.toMatchObject({ code: "DemoLimitReached" });
    });

    it("deletes demo accounts after their lifetime, with their files, and leaves everyone else alone", async () => {
      await seedTemplate();
      const old = await startDemo();
      const fresh = await startDemo();
      const normal = await pool.query<{ id: string }>(
        "INSERT INTO users (email, name, password_hash, created_at) VALUES ('old-normal@test.com', 'N', 'x', now() - interval '90 days') RETURNING id",
      );
      await pool.query(
        "UPDATE users SET created_at = now() - interval '25 hours' WHERE id = $1",
        [old.user.resourceId],
      );
      expect(existsSync(join(STORAGE, old.user.resourceId))).toBe(true);

      const removed = await demo.cleanupExpired();

      expect(removed).toBe(1);
      const left = await pool.query<{ id: string }>("SELECT id FROM users");
      const ids = left.rows.map((r) => r.id);
      expect(ids).not.toContain(old.user.resourceId);
      expect(ids).toContain(fresh.user.resourceId);
      expect(ids).toContain(normal.rows[0]!.id);
      expect(existsSync(join(STORAGE, old.user.resourceId))).toBe(false);
      expect(existsSync(join(STORAGE, fresh.user.resourceId))).toBe(true);
    });
  },
);
