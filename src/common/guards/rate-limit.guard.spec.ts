import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { configureApp, createAdapter } from "../../app.setup";
import { ConfigModule } from "../../config/config.module";
import { loadEnv } from "../../config/env.schema";
import { REDIS } from "../../integrations/redis/redis.module";
import { RateLimit } from "../decorators/rate-limit.decorator";
import { AllExceptionsFilter } from "../filters/all-exceptions.filter";
import { RateLimitGuard } from "./rate-limit.guard";

// Stands in for JwtAuthGuard: "x-user" is the signed-in user id.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const id = req.headers["x-user"];
    if (typeof id === "string") req.user = { id, role: "user" };
    return true;
  }
}

@Controller("t")
class TestController {
  @Get("user")
  @RateLimit({ name: "a", limit: 2, windowSeconds: 60, by: "user" })
  byUser() {
    return { ok: true };
  }

  @Get("user-too")
  @RateLimit({ name: "a", limit: 2, windowSeconds: 60, by: "user" })
  sameBucket() {
    return { ok: true };
  }

  @Get("ip")
  @RateLimit({ name: "b", limit: 1, windowSeconds: 60, by: "ip" })
  byIp() {
    return { ok: true };
  }

  @Get("free")
  free() {
    return { ok: true };
  }
}

/** The bit of ioredis the guard uses: multi().incr().pexpire(key, ms, "NX").pttl().exec(). */
class FakeRedis {
  counts = new Map<string, number>();
  calls = 0;
  down = false;

  multi() {
    const chain = {
      key: "",
      incr: (key: string) => {
        chain.key = key;
        return chain;
      },
      pexpire: () => chain,
      pttl: () => chain,
      exec: async () => {
        this.calls += 1;
        if (this.down) throw new Error("Connection is closed.");
        const next = (this.counts.get(chain.key) ?? 0) + 1;
        this.counts.set(chain.key, next);
        return [
          [null, next],
          [null, 1],
          [null, 42_000],
        ];
      },
    };
    return chain;
  }
}

describe("RateLimitGuard", () => {
  let app: NestFastifyApplication;
  const redis = new FakeRedis();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule],
      controllers: [TestController],
      providers: [
        { provide: REDIS, useValue: redis },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      createAdapter(),
      { logger: false },
    );
    await configureApp(app, loadEnv(process.env));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    redis.counts.clear();
    redis.calls = 0;
    redis.down = false;
  });

  const get = (url: string, user?: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/t/${url}`,
      headers: user ? { "x-user": user } : {},
    });

  it("allows the limit, then answers 429 RateLimited with Retry-After", async () => {
    expect((await get("user", "u1")).statusCode).toBe(200);
    expect((await get("user", "u1")).statusCode).toBe(200);

    const blocked = await get("user", "u1");

    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe("RateLimited");
    expect(blocked.headers["retry-after"]).toBe("42");
    expect(blocked.json().message).toContain("42 seconds");
  });

  it("counts each user separately, and routes with the same name share one counter", async () => {
    await get("user", "u1");
    await get("user-too", "u1");
    expect((await get("user", "u1")).statusCode).toBe(429);
    expect((await get("user", "u2")).statusCode).toBe(200);
  });

  it("counts by IP for routes that have no user", async () => {
    expect((await get("ip")).statusCode).toBe(200);
    expect((await get("ip")).statusCode).toBe(429);
  });

  it("leaves routes without a limit alone", async () => {
    for (let i = 0; i < 5; i++)
      expect((await get("free", "u1")).statusCode).toBe(200);
    expect(redis.calls).toBe(0);
  });

  it("lets requests through when Redis is down", async () => {
    redis.down = true;
    for (let i = 0; i < 4; i++)
      expect((await get("user", "u1")).statusCode).toBe(200);
  });
});
