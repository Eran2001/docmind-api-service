import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { JwtModule, JwtService } from "@nestjs/jwt";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { configureApp, createAdapter } from "../src/app.setup";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { JwtAuthGuard } from "../src/common/guards/jwt-auth.guard";
import { ResponseInterceptor } from "../src/common/interceptors/response.interceptor";
import { APP_CONFIG } from "../src/config/config.module";
import { loadEnv } from "../src/config/env.schema";
import { AuthController } from "../src/modules/auth/auth.controller";
import { AuthService } from "../src/modules/auth/auth.service";
import { RefreshTokensRepository } from "../src/modules/auth/refresh-tokens.repository";
import { TokensService } from "../src/modules/auth/tokens.service";
import { UsersRepository, type UserRow } from "../src/modules/users/users.repository";
import { UsersService } from "../src/modules/users/users.service";

const config = loadEnv(process.env);

// In-memory stand-ins for the two repositories, so these tests need no Postgres.
class FakeUsersRepository {
  rows: UserRow[] = [];
  async findByEmail(email: string) {
    return this.rows.find((r) => r.email === email);
  }
  async findById(id: string) {
    return this.rows.find((r) => r.id === id);
  }
  async create(input: { email: string; passwordHash: string; name: string }) {
    const row: UserRow = {
      id: crypto.randomUUID(),
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    };
    this.rows.push(row);
    return row;
  }
}
class FakeRefreshTokensRepository {
  stored: { userId: string; tokenHash: string; expiresAt: Date }[] = [];
  async create(input: { userId: string; tokenHash: string; expiresAt: Date }) {
    this.stored.push(input);
  }
}

describe("auth", () => {
  let app: NestFastifyApplication;
  let users: FakeUsersRepository;
  let refresh: FakeRefreshTokensRepository;
  let jwt: JwtService;

  beforeAll(async () => {
    users = new FakeUsersRepository();
    refresh = new FakeRefreshTokensRepository();
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: config.JWT_SECRET, signOptions: { algorithm: "HS256" } })],
      controllers: [AuthController],
      providers: [
        AuthService,
        TokensService,
        UsersService,
        { provide: UsersRepository, useValue: users },
        { provide: RefreshTokensRepository, useValue: refresh },
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), { logger: false });
    await configureApp(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwt = moduleRef.get(JwtService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    users.rows = [];
    refresh.stored = [];
  });

  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url: `/api/v1/auth${url}`, payload: payload as object });
  const me = (token?: string) =>
    app.inject({ method: "GET", url: "/api/v1/auth/me", headers: token ? { authorization: `Bearer ${token}` } : {} });
  const valid = { name: "Maya Chen", email: "Maya.Chen@Acme.com", password: "correct-horse-1" };

  describe("POST /auth/register", () => {
    it("creates the account and returns the token and user inside data", async () => {
      const res = await post("/register", valid);
      const body = res.json();
      expect(res.statusCode).toBe(201);
      expect(body).toMatchObject({ code: "OK", message: "Account created." });
      expect(body.data.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(body.data).toMatchObject({ tokenType: "Bearer", expiresIn: 900 });
      expect(body.data.user).toMatchObject({ name: "Maya Chen", email: "maya.chen@acme.com", role: "user" });
      expect(body.data.user.id).toBe(body.resourceId);
      expect(body.data.user).not.toHaveProperty("passwordHash");
      expect(JSON.stringify(body)).not.toContain("argon2");
    });

    it("stores an argon2id hash, never the password", async () => {
      await post("/register", valid);
      expect(users.rows[0]?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(users.rows[0]?.passwordHash).not.toContain("correct-horse");
    });

    it("sets the refresh token in an httpOnly cookie and stores only its hash", async () => {
      const res = await post("/register", valid);
      const cookie = res.headers["set-cookie"] as string;
      expect(cookie).toMatch(/^dm_refresh=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toContain("Path=/api/v1/auth");
      const raw = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
      expect(refresh.stored).toHaveLength(1);
      expect(refresh.stored[0]?.tokenHash).not.toBe(raw);
      expect(refresh.stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // the refresh token is not in the JSON body
      expect(res.body).not.toContain(raw);
    });

    it("rejects a duplicate email (any letter case) with EmailAlreadyRegistered", async () => {
      await post("/register", valid);
      const res = await post("/register", { ...valid, email: "MAYA.CHEN@acme.com" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: "EmailAlreadyRegistered",
        message: "An account with this email already exists.",
        error: { status: 409, details: { fieldErrors: { email: ["An account with this email already exists."] } } },
      });
      expect(users.rows).toHaveLength(1);
    });

    it("validates the body and reports field errors", async () => {
      const res = await post("/register", { name: "", email: "nope", password: "short" });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe("ValidationFailed");
      expect(Object.keys(body.error.details.fieldErrors).sort()).toEqual(["email", "name", "password"]);
      expect(users.rows).toHaveLength(0);
    });

    it("reports a missing body as ValidationFailed too", async () => {
      expect((await post("/register", undefined)).json().code).toBe("ValidationFailed");
    });
  });

  describe("POST /auth/login", () => {
    beforeEach(async () => {
      await post("/register", valid);
      refresh.stored = [];
    });

    it("signs in with any letter case in the email and returns token and user in data", async () => {
      const res = await post("/login", { email: "MAYA.CHEN@ACME.COM", password: valid.password });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", message: "Signed in.", data: { tokenType: "Bearer", user: { email: "maya.chen@acme.com" } } });
      expect(res.json().data.accessToken).toBeTruthy();
      expect(res.headers["set-cookie"]).toMatch(/^dm_refresh=/);
      expect(refresh.stored).toHaveLength(1);
    });

    it("returns the same Unauthorized message for a wrong password and an unknown email", async () => {
      const wrongPassword = await post("/login", { email: valid.email, password: "wrong-password" });
      const unknownEmail = await post("/login", { email: "nobody@acme.com", password: "wrong-password" });
      for (const res of [wrongPassword, unknownEmail]) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ code: "Unauthorized", message: "Invalid email or password." });
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
    });

    it("validates the body", async () => {
      const res = await post("/login", { email: "", password: "" });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("ValidationFailed");
    });
  });

  describe("GET /auth/me (protected)", () => {
    it("returns the user for a valid token", async () => {
      const token = (await post("/register", valid)).json().data.accessToken as string;
      const res = await me(token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", data: { user: { name: "Maya Chen", email: "maya.chen@acme.com", role: "user" } } });
    });

    it("rejects a request without a token", async () => {
      const res = await me();
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "Unauthorized", message: "Authentication required." });
    });

    it("rejects garbage, tampered and wrong-secret tokens", async () => {
      const token = (await post("/register", valid)).json().data.accessToken as string;
      const [h, p, s] = token.split(".");
      const forged = await jwt.signAsync({ sub: "x", role: "admin" }, { secret: "another-secret-another-secret-another-secret" });
      for (const bad of ["garbage", `${h}.${p}.${s}x`, forged]) {
        const res = await me(bad);
        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe("Unauthorized");
      }
    });

    it("rejects an expired token", async () => {
      const token = (await post("/register", valid)).json().data.accessToken as string;
      const { sub, role } = jwt.decode<{ sub: string; role: string }>(token);
      const expired = await jwt.signAsync({ sub, role }, { expiresIn: -10 });
      const res = await me(expired);
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe("Session expired. Please sign in again.");
    });

    it("rejects a valid token whose user no longer exists", async () => {
      const token = (await post("/register", valid)).json().data.accessToken as string;
      users.rows = [];
      expect((await me(token)).statusCode).toBe(401);
    });

    it("only accepts the Bearer scheme", async () => {
      const token = (await post("/register", valid)).json().data.accessToken as string;
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Basic ${token}` } });
      expect(res.statusCode).toBe(401);
    });
  });
});
