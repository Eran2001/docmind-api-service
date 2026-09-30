import { Test } from "@nestjs/testing";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureApp, createAdapter } from "../src/app.setup";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { APP_CONFIG } from "../src/config/config.module";
import { loadEnv } from "../src/config/env.schema";
import { PG_POOL } from "../src/database/database.module";
import { AiClient } from "../src/integrations/ai/ai.client";
import { REDIS } from "../src/integrations/redis/redis.module";
import { HealthController } from "../src/modules/health/health.controller";
import { HealthService } from "../src/modules/health/health.service";

const config = loadEnv(process.env);

// Real controller, service, filter and app setup (prefix, helmet, cookies, CORS, request id); only the I/O is faked.
async function createApp(io: { db?: boolean; redis?: boolean; ai?: boolean }) {
  const { db = true, redis = true, ai = true } = io;
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      { provide: APP_CONFIG, useValue: config },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
      { provide: PG_POOL, useValue: { query: db ? vi.fn().mockResolvedValue({}) : vi.fn().mockRejectedValue(new Error("down")) } },
      { provide: REDIS, useValue: { ping: redis ? vi.fn().mockResolvedValue("PONG") : vi.fn().mockRejectedValue(new Error("down")) } },
      { provide: AiClient, useValue: { isHealthy: vi.fn().mockResolvedValue(ai) } },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), { logger: false });
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe("GET /api/v1/health", () => {
  let app: NestFastifyApplication;
  afterEach(async () => {
    await app.close();
  });

  it("is ok when everything is up", async () => {
    app = await createApp({});
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: "OK", message: "OK", data: { status: "ok", db: "up", redis: "up", ai: "up" } });
    expect(res.json().requestId).toBe(res.headers["x-request-id"]);
  });

  it("is degraded (still 200) when only the AI service is down", async () => {
    app = await createApp({ ai: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ code: "OK", data: { status: "degraded", db: "up", redis: "up", ai: "down" } });
  });

  it("is 503 when the database is down", async () => {
    app = await createApp({ db: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "ServiceUnavailable", data: { status: "down", db: "down", redis: "up" } });
  });

  it("is 503 when Redis is down", async () => {
    app = await createApp({ redis: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "ServiceUnavailable", data: { status: "down", redis: "down" } });
  });
});

describe("app setup", () => {
  let app: NestFastifyApplication;
  beforeEach(async () => {
    app = await createApp({});
  });
  afterEach(async () => {
    await app.close();
  });

  it("generates an X-Request-Id and reuses a valid incoming one", async () => {
    const generated = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const reused = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-request-id": "trace-abc-12345" } });
    expect(reused.headers["x-request-id"]).toBe("trace-abc-12345");

    const rejected = await app.inject({ method: "GET", url: "/api/v1/health", headers: { "x-request-id": "bad id with spaces!" } });
    expect(rejected.headers["x-request-id"]).not.toBe("bad id with spaces!");
  });

  it("returns the standard error shape (with a request id) for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "ApiRouteFailed", message: "Route not found.", error: { status: 404 } });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("returns ValidationFailed for malformed JSON bodies", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/health", headers: { "content-type": "application/json" }, payload: "{bad" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "ValidationFailed", error: { status: 400 } });
  });

  it("sets security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
  });

  it("allows CORS only for the configured web origins, with credentials", async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: "OPTIONS",
        url: "/api/v1/health",
        headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
      });

    const allowed = await preflight(config.WEB_ORIGIN[0]!);
    expect(allowed.headers["access-control-allow-origin"]).toBe(config.WEB_ORIGIN[0]);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(allowed.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");

    const blocked = await preflight("https://evil.example");
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
