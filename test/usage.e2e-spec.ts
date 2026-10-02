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
import { UsageModule } from "../src/modules/usage/usage.module";

const config = loadEnv(process.env);

describe.skipIf(!inject("dbReady"))("usage routes (real Postgres)", () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        StorageModule,
        AuthModule,
        UsageModule,
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
      payload: { name: "Usage tester", email, password: "password123" },
    });
    return {
      token: res.json().data.accessToken as string,
      id: res.json().data.user.resourceId as string,
    };
  };

  const addEvent = (
    userId: string,
    kind: string,
    daysAgo: number,
    cost: string,
    input = 100,
    output = 50,
    latency = 1000,
  ) =>
    pool.query(
      `INSERT INTO usage_events (user_id, kind, model, input_tokens, output_tokens, cost_usd, latency_ms, created_at)
       VALUES ($1, $2, 'test-model', $3, $4, $5, $6, now() - ($7 || ' days')::interval)`,
      [userId, kind, input, output, cost, latency, String(daysAgo)],
    );

  const get = (token: string, query = "") =>
    app.inject({
      method: "GET",
      url: `/api/v1/usage/me${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it("needs a signed-in user", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/usage/me" });
    expect(res.statusCode).toBe(401);
  });

  it("is all zeros, with a full day list and no comparison, for a new user", async () => {
    const user = await register("usage-new@test.com");

    const res = await get(user.token, "?days=7");

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.days).toBe(7);
    expect(data.totals).toEqual({
      costUsd: 0,
      tokens: 0,
      requests: 0,
      avgLatencyMs: 0,
    });
    expect(data.previous).toBeNull();
    expect(data.daily).toHaveLength(7);
    expect(data.byKind.map((k: { kind: string }) => k.kind)).toEqual([
      "answer",
      "embed",
      "judge",
      "rewrite",
    ]);
  });

  it("sums only the caller's events, per day and per kind, and compares with the previous period", async () => {
    const user = await register("usage-owner@test.com");
    const other = await register("usage-other@test.com");
    await addEvent(user.id, "answer", 0, "0.010000", 100, 50, 2000);
    await addEvent(user.id, "embed", 0, "0.002000", 200, 0, 1000);
    await addEvent(user.id, "answer", 3, "0.020000");
    await addEvent(user.id, "answer", 10, "0.100000"); // previous 7-day period
    await addEvent(other.id, "answer", 0, "9.000000"); // someone else

    const data = (await get(user.token, "?days=7")).json().data;

    expect(data.totals.requests).toBe(3);
    expect(data.totals.costUsd).toBeCloseTo(0.032, 6);
    expect(data.totals.tokens).toBe(150 + 200 + 150);
    expect(data.totals.avgLatencyMs).toBe(1333);
    expect(data.previous).toMatchObject({ requests: 1 });
    expect(data.previous.costUsd).toBeCloseTo(0.1, 6);

    expect(data.daily).toHaveLength(7);
    const today = data.daily[6];
    expect(today.requests).toBe(2);
    expect(today.costUsd).toBeCloseTo(0.012, 6);
    expect(data.daily[3].requests).toBe(1);
    expect(data.daily[0]).toMatchObject({ costUsd: 0, requests: 0 });

    const answer = data.byKind.find(
      (k: { kind: string }) => k.kind === "answer",
    );
    expect(answer).toMatchObject({ requests: 2, tokens: 300 });
    expect(answer.costUsd).toBeCloseTo(0.03, 6);
    expect(
      data.byKind.find((k: { kind: string }) => k.kind === "judge"),
    ).toMatchObject({ requests: 0, costUsd: 0 });
  });

  it("defaults to 30 days and rejects a bad range", async () => {
    const user = await register("usage-days@test.com");

    expect((await get(user.token)).json().data.days).toBe(30);
    expect((await get(user.token, "?days=0")).statusCode).toBe(400);
    expect((await get(user.token, "?days=abc")).statusCode).toBe(400);
    expect((await get(user.token, "?days=1000")).statusCode).toBe(400);
  });

  it("exports one CSV row per call, only the caller's, as a download", async () => {
    const user = await register("usage-csv@test.com");
    const other = await register("usage-csv-other@test.com");
    await addEvent(user.id, "answer", 1, "0.010000", 100, 50, 2000);
    await addEvent(user.id, "embed", 0, "0.002000", 200, 0, 1000);
    await addEvent(user.id, "answer", 40, "0.5"); // outside the 7-day window
    await addEvent(other.id, "answer", 0, "9.000000");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/usage/me/export?days=7",
      headers: { authorization: `Bearer ${user.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="usage-7d.csv"',
    );
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "created_at,kind,model,input_tokens,output_tokens,cost_usd,latency_ms",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z,answer,test-model,100,50,0\.010000,2000$/,
    );
    expect(lines[2]).toContain(",embed,test-model,200,0,0.002000,1000");
  });

  it("exports only the header for a user with no events, and needs sign-in", async () => {
    const user = await register("usage-csv-empty@test.com");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/usage/me/export",
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.body.trim().split("\r\n")).toHaveLength(1);

    const anon = await app.inject({
      method: "GET",
      url: "/api/v1/usage/me/export",
    });
    expect(anon.statusCode).toBe(401);
  });

  it("shows everyone's usage and the top spenders to an admin, and hides it from users", async () => {
    const admin = await register("usage-admin@test.com");
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [
      admin.id,
    ]);
    // The role is read from the access token, so sign in again to get an admin token.
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "usage-admin@test.com", password: "password123" },
    });
    const adminToken = login.json().data.accessToken as string;
    const big = await register("usage-big@test.com");
    const small = await register("usage-small@test.com");
    await addEvent(big.id, "answer", 0, "5.000000", 1000, 500, 3000);
    await addEvent(big.id, "embed", 1, "1.000000", 100, 0, 1000);
    await addEvent(small.id, "answer", 0, "0.500000", 10, 5, 1000);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/usage?days=7",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.totals.requests).toBe(3);
    expect(data.totals.costUsd).toBeCloseTo(6.5, 6);
    expect(data.daily).toHaveLength(7);
    expect(data.topUsers).toHaveLength(2);
    expect(data.topUsers[0]).toMatchObject({
      resourceId: big.id,
      name: "Usage tester",
      email: "usage-big@test.com",
      requests: 2,
      tokens: 1600,
    });
    expect(data.topUsers[0].costUsd).toBeCloseTo(6, 6);
    expect(data.topUsers[1].resourceId).toBe(small.id);

    const csv = await app.inject({
      method: "GET",
      url: "/api/v1/admin/usage/export?days=7",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toBe(
      'attachment; filename="admin-usage-7d.csv"',
    );
    const csvLines = csv.body.trim().split("\r\n");
    expect(csvLines[0]).toBe(
      "user_email,user_name,created_at,kind,model,input_tokens,output_tokens,cost_usd,latency_ms",
    );
    expect(csvLines).toHaveLength(4);
    expect(
      csvLines.filter((l) => l.startsWith("usage-big@test.com,")),
    ).toHaveLength(2);
    expect(
      csvLines.filter((l) => l.startsWith("usage-small@test.com,")),
    ).toHaveLength(1);

    const exportAsUser = await app.inject({
      method: "GET",
      url: "/api/v1/admin/usage/export",
      headers: { authorization: `Bearer ${big.token}` },
    });
    expect(exportAsUser.statusCode).toBe(404);

    const asUser = await app.inject({
      method: "GET",
      url: "/api/v1/admin/usage",
      headers: { authorization: `Bearer ${big.token}` },
    });
    expect(asUser.statusCode).toBe(404);
    expect(asUser.json().code).toBe("NotFound");
  });
});
