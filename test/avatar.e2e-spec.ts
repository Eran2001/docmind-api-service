import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { existsSync } from "node:fs";
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

const config = loadEnv(process.env);
const STORAGE = resolve(config.STORAGE_DIR);

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("not really a picture, but it starts like one"),
]);
const JPEG = Buffer.concat([
  Buffer.from("ffd8ffe0", "hex"),
  Buffer.from("jpeg bytes"),
]);

describe.skipIf(!inject("dbReady"))(
  "avatar routes (real Postgres and disk)",
  () => {
    let app: NestFastifyApplication;
    let pool: Pool;

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule, StorageModule, AuthModule],
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
      await rm(STORAGE, { recursive: true, force: true });
    });
    beforeEach(async () => {
      await pool.query("TRUNCATE users CASCADE");
      await rm(STORAGE, { recursive: true, force: true });
    });

    const register = async (email: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { name: "Avatar tester", email, password: "password123" },
      });
      return {
        token: res.json().data.accessToken as string,
        id: res.json().data.user.resourceId as string,
      };
    };
    const upload = (token: string, content: Buffer, field = "file") => {
      const boundary = `----docmind${Math.random().toString(16).slice(2)}`;
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="me.png"\r\nContent-Type: image/png\r\n\r\n`;
      return app.inject({
        method: "POST",
        url: "/api/v1/auth/me/avatar",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(head),
          content,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    };
    const me = async (token: string) =>
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: { authorization: `Bearer ${token}` },
        })
      ).json().data.user;
    const getAvatar = (token: string) =>
      app.inject({
        method: "GET",
        url: "/api/v1/auth/me/avatar",
        headers: { authorization: `Bearer ${token}` },
      });

    it("stores a picture, serves the same bytes back, and flags hasAvatar", async () => {
      const user = await register("avatar-a@test.com");
      expect((await me(user.token)).hasAvatar).toBe(false);
      expect((await getAvatar(user.token)).statusCode).toBe(404);

      const res = await upload(user.token, PNG);

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ result: true });
      expect((await me(user.token)).hasAvatar).toBe(true);
      const served = await getAvatar(user.token);
      expect(served.statusCode).toBe(200);
      expect(served.headers["content-type"]).toBe("image/png");
      expect(served.rawPayload.equals(PNG)).toBe(true);
    });

    it("replaces the old picture and deletes its file", async () => {
      const user = await register("avatar-b@test.com");
      await upload(user.token, PNG);
      const first = await pool.query<{ avatar_path: string }>(
        "SELECT avatar_path FROM users WHERE id = $1",
        [user.id],
      );
      const firstPath = join(STORAGE, first.rows[0]!.avatar_path);
      expect(existsSync(firstPath)).toBe(true);

      await upload(user.token, JPEG);

      expect(existsSync(firstPath)).toBe(false);
      const served = await getAvatar(user.token);
      expect(served.headers["content-type"]).toBe("image/jpeg");
      expect(served.rawPayload.equals(JPEG)).toBe(true);
    });

    it("removes the picture", async () => {
      const user = await register("avatar-c@test.com");
      await upload(user.token, PNG);

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/me/avatar",
        headers: { authorization: `Bearer ${user.token}` },
      });

      expect(res.statusCode).toBe(200);
      expect((await me(user.token)).hasAvatar).toBe(false);
      expect((await getAvatar(user.token)).statusCode).toBe(404);
    });

    it("refuses anything that is not a PNG, JPEG or WebP, too big, or sent in the wrong field", async () => {
      const user = await register("avatar-d@test.com");

      const text = await upload(user.token, Buffer.from("just text"));
      expect(text.statusCode).toBe(400);
      expect(text.json().code).toBe("ValidationFailed");

      const big = await upload(
        user.token,
        Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]),
      );
      expect(big.statusCode).toBe(400);

      expect((await upload(user.token, PNG, "picture")).statusCode).toBe(400);
      expect((await me(user.token)).hasAvatar).toBe(false);
    });

    it("keeps pictures private to their owner and needs a sign-in", async () => {
      const owner = await register("avatar-e@test.com");
      const other = await register("avatar-f@test.com");
      await upload(owner.token, PNG);

      expect((await getAvatar(other.token)).statusCode).toBe(404);
      const anon = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me/avatar",
      });
      expect(anon.statusCode).toBe(401);
    });
  },
);
