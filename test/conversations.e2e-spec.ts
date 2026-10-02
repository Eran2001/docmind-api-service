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
import { ConversationsModule } from "../src/modules/conversations/conversations.module";

const config = loadEnv(process.env);

describe.skipIf(!inject("dbReady"))(
  "conversation list pagination (real Postgres)",
  () => {
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
          ConversationsModule,
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
        payload: { name: "Pager", email, password: "password123" },
      });
      return {
        token: res.json().data.accessToken as string,
        id: res.json().data.user.resourceId as string,
      };
    };
    const list = (token: string, collectionId: string, query = "") =>
      app.inject({
        method: "GET",
        url: `/api/v1/collections/${collectionId}/conversations${query}`,
        headers: { authorization: `Bearer ${token}` },
      });

    it("walks every conversation exactly once, newest activity first, even with equal and microsecond-apart times", async () => {
      const user = await register("pager@test.com");
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${user.token}` },
        payload: { name: "Chats" },
      });
      const collectionId = created.json().resourceId as string;
      // Seven rows: two share the exact same time (the id breaks the tie), two differ by microseconds (a JS Date can't tell them apart).
      const times = [
        "2026-10-01 10:00:00.000000+00",
        "2026-10-01 10:00:01.123456+00",
        "2026-10-01 10:00:01.123200+00",
        "2026-10-01 10:00:02.000000+00",
        "2026-10-01 10:00:02.000000+00",
        "2026-10-01 10:00:03.000000+00",
        "2026-10-01 10:00:04.000000+00",
      ];
      for (const [index, time] of times.entries()) {
        await pool.query(
          "INSERT INTO conversations (collection_id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
          [collectionId, user.id, `chat ${index}`, time],
        );
      }
      const expected = (
        await pool.query<{ id: string }>(
          "SELECT id FROM conversations ORDER BY updated_at DESC, id DESC",
        )
      ).rows.map((row) => row.id);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
        const res = await list(user.token, collectionId, query);
        expect(res.statusCode).toBe(200);
        const data = res.json().data;
        expect(data.result.length).toBeLessThanOrEqual(3);
        seen.push(
          ...data.result.map((c: { resourceId: string }) => c.resourceId),
        );
        cursor = data.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
    });

    it("has no nextCursor when everything fits, defaults to 20, and rejects bad cursors and sizes", async () => {
      const user = await register("pager2@test.com");
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${user.token}` },
        payload: { name: "Chats" },
      });
      const collectionId = created.json().resourceId as string;
      await pool.query(
        "INSERT INTO conversations (collection_id, user_id) SELECT $1, $2 FROM generate_series(1, 25)",
        [collectionId, user.id],
      );

      const first = (await list(user.token, collectionId)).json().data;
      expect(first.result).toHaveLength(20);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = (
        await list(user.token, collectionId, `?cursor=${first.nextCursor}`)
      ).json().data;
      expect(second.result).toHaveLength(5);
      expect(second.nextCursor).toBeNull();

      expect(
        (await list(user.token, collectionId, "?cursor=garbage")).statusCode,
      ).toBe(400);
      expect(
        (await list(user.token, collectionId, "?limit=101")).statusCode,
      ).toBe(400);
      expect(
        (await list(user.token, collectionId, "?limit=0")).statusCode,
      ).toBe(400);
    });

    it("does not list another user's conversations", async () => {
      const owner = await register("pager3@test.com");
      const other = await register("pager4@test.com");
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/collections",
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { name: "Private" },
      });

      const res = await list(other.token, created.json().resourceId as string);

      expect(res.statusCode).toBe(404);
    });
  },
);
