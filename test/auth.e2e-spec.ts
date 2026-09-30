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
import { RefreshTokensRepository, type RefreshTokenRow } from "../src/modules/auth/refresh-tokens.repository";
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
    const row: UserRow = { id: crypto.randomUUID(), role: "user", createdAt: new Date(), updatedAt: new Date(), ...input };
    this.rows.push(row);
    return row;
  }
  async updateProfile(id: string, input: { name: string; email: string }) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return undefined;
    // Same as Postgres' unique index on users.email
    if (this.rows.some((r) => r.id !== id && r.email === input.email)) throw Object.assign(new Error("duplicate"), { code: "23505" });
    Object.assign(row, input);
    return row;
  }
  async updatePasswordHash(id: string, passwordHash: string) {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.passwordHash = passwordHash;
  }
  async delete(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

class FakeRefreshTokensRepository {
  rows: RefreshTokenRow[] = [];
  async create(input: { userId: string; tokenHash: string; expiresAt: Date }) {
    const row: RefreshTokenRow = { id: crypto.randomUUID(), revokedAt: null, createdAt: new Date(), ...input };
    this.rows.push(row);
    return row;
  }
  async findByHash(tokenHash: string) {
    return this.rows.find((r) => r.tokenHash === tokenHash);
  }
  async revoke(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.revokedAt) return false;
    row.revokedAt = new Date();
    return true;
  }
  async revokeAllForUser(userId: string, exceptId?: string) {
    for (const r of this.rows) if (r.userId === userId && !r.revokedAt && r.id !== exceptId) r.revokedAt = new Date();
  }
  active(userId: string) {
    return this.rows.filter((r) => r.userId === userId && !r.revokedAt);
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
    refresh.rows = [];
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
      expect(refresh.rows).toHaveLength(1);
      expect(refresh.rows[0]?.tokenHash).not.toBe(raw);
      expect(refresh.rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
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
      refresh.rows = [];
    });

    it("signs in with any letter case in the email and returns token and user in data", async () => {
      const res = await post("/login", { email: "MAYA.CHEN@ACME.COM", password: valid.password });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", message: "Signed in.", data: { tokenType: "Bearer", user: { email: "maya.chen@acme.com" } } });
      expect(res.json().data.accessToken).toBeTruthy();
      expect(res.headers["set-cookie"]).toMatch(/^dm_refresh=/);
      expect(refresh.rows).toHaveLength(1);
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

  // ---- helpers for the session tests ----
  const refreshCookieOf = (res: { headers: Record<string, unknown> }) => {
    const header = res.headers["set-cookie"];
    const line = (Array.isArray(header) ? header : [header]).find((c) => String(c).startsWith("dm_refresh=")) as string | undefined;
    return line ? { value: decodeURIComponent(line.split(";")[0]!.split("=")[1]!), line } : undefined;
  };
  const withCookie = (value: string) => ({ cookie: `dm_refresh=${encodeURIComponent(value)}` });
  const register = async (over: Partial<typeof valid> = {}) => {
    const res = await post("/register", { ...valid, ...over });
    return { token: res.json().data.accessToken as string, refreshToken: refreshCookieOf(res)!.value, user: res.json().data.user };
  };
  const call = (method: "PATCH" | "POST" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/api/v1/auth${url}`, payload: payload as object, headers });
  const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

  describe("POST /auth/refresh", () => {
    it("trades the refresh cookie for a new access token and a NEW refresh cookie (rotation)", async () => {
      const first = await register();
      const res = await call("POST", "/refresh", undefined, withCookie(first.refreshToken));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", message: "Session refreshed.", data: { tokenType: "Bearer", user: { email: "maya.chen@acme.com" } } });
      expect((await me(res.json().data.accessToken)).statusCode).toBe(200);
      const rotated = refreshCookieOf(res)!;
      expect(rotated.value).not.toBe(first.refreshToken);
      expect(rotated.line).toMatch(/HttpOnly/i);
      // the old one is revoked, the new one is the only active session
      expect(refresh.active(first.user.id)).toHaveLength(1);
    });

    it("works with the new cookie, and only once per cookie", async () => {
      const first = await register();
      const second = await call("POST", "/refresh", undefined, withCookie(first.refreshToken));
      const third = await call("POST", "/refresh", undefined, withCookie(refreshCookieOf(second)!.value));
      expect(third.statusCode).toBe(200);
      const reuse = await call("POST", "/refresh", undefined, withCookie(first.refreshToken));
      expect(reuse.statusCode).toBe(401);
      expect(reuse.json().code).toBe("Unauthorized");
    });

    it("rejects a missing, unknown or expired refresh token and clears the dead cookie", async () => {
      const { refreshToken, user } = await register();
      const missing = await call("POST", "/refresh");
      expect(missing.statusCode).toBe(401);
      const unknown = await call("POST", "/refresh", undefined, withCookie("not-a-real-token"));
      expect(unknown.statusCode).toBe(401);
      expect(String(unknown.headers["set-cookie"])).toMatch(/dm_refresh=;/); // cleared
      refresh.active(user.id)[0]!.expiresAt = new Date(Date.now() - 1000);
      expect((await call("POST", "/refresh", undefined, withCookie(refreshToken))).statusCode).toBe(401);
    });

    it("treats a rotated token shown again right away as a race, not theft: no sessions are revoked", async () => {
      const first = await register();
      const rotated = await call("POST", "/refresh", undefined, withCookie(first.refreshToken));
      const raced = await call("POST", "/refresh", undefined, withCookie(first.refreshToken));
      expect(raced.statusCode).toBe(401);
      // the session created by the winning refresh still works
      expect((await call("POST", "/refresh", undefined, withCookie(refreshCookieOf(rotated)!.value))).statusCode).toBe(200);
    });

    it("treats a rotated token shown again LATER as theft: every session of the user is revoked", async () => {
      const first = await register();
      const other = await post("/login", { email: valid.email, password: valid.password }); // a second device
      const rotated = await call("POST", "/refresh", undefined, withCookie(first.refreshToken));
      // pretend the rotation happened a minute ago
      refresh.rows.find((r) => r.revokedAt)!.revokedAt = new Date(Date.now() - 60_000);
      const replay = await call("POST", "/refresh", undefined, withCookie(first.refreshToken));
      expect(replay.statusCode).toBe(401);
      expect(refresh.active(first.user.id)).toHaveLength(0);
      // neither the legitimate new cookie nor the other device can refresh any more
      expect((await call("POST", "/refresh", undefined, withCookie(refreshCookieOf(rotated)!.value))).statusCode).toBe(401);
      expect((await call("POST", "/refresh", undefined, withCookie(refreshCookieOf(other)!.value))).statusCode).toBe(401);
    });

    it("rejects a refresh token whose user was deleted", async () => {
      const { refreshToken } = await register();
      users.rows = [];
      expect((await call("POST", "/refresh", undefined, withCookie(refreshToken))).statusCode).toBe(401);
    });
  });

  describe("POST /auth/logout", () => {
    it("revokes this browser's refresh token and clears the cookie, without needing a valid access token", async () => {
      const { refreshToken, user } = await register();
      const res = await call("POST", "/logout", undefined, withCookie(refreshToken));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", message: "Signed out.", data: null });
      expect(String(res.headers["set-cookie"])).toMatch(/dm_refresh=;/);
      expect(refresh.active(user.id)).toHaveLength(0);
      expect((await call("POST", "/refresh", undefined, withCookie(refreshToken))).statusCode).toBe(401);
    });

    it("succeeds even when already signed out", async () => {
      expect((await call("POST", "/logout")).statusCode).toBe(200);
      expect((await call("POST", "/logout", undefined, withCookie("garbage"))).statusCode).toBe(200);
    });

    it("only signs out this device", async () => {
      const first = await register();
      const other = await post("/login", { email: valid.email, password: valid.password });
      await call("POST", "/logout", undefined, withCookie(first.refreshToken));
      expect((await call("POST", "/refresh", undefined, withCookie(refreshCookieOf(other)!.value))).statusCode).toBe(200);
    });
  });

  describe("PATCH /auth/me", () => {
    it("updates name and email and returns the user", async () => {
      const { token } = await register();
      const res = await call("PATCH", "/me", { name: "Maya C.", email: "New.Address@Acme.com" }, authed(token));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", message: "Profile updated.", data: { user: { name: "Maya C.", email: "new.address@acme.com", role: "user" } } });
      expect((await me(token)).json().data.user.email).toBe("new.address@acme.com");
      expect((await post("/login", { email: "new.address@acme.com", password: valid.password })).statusCode).toBe(200);
    });

    it("rejects an email that belongs to someone else with EmailAlreadyRegistered", async () => {
      await register({ email: "taken@acme.com" });
      const { token } = await register();
      const res = await call("PATCH", "/me", { name: "Maya", email: "TAKEN@acme.com" }, authed(token));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "EmailAlreadyRegistered", error: { details: { fieldErrors: { email: [expect.any(String)] } } } });
    });

    it("keeps your own email, validates the body and needs a token", async () => {
      const { token } = await register();
      expect((await call("PATCH", "/me", { name: "Maya", email: valid.email }, authed(token))).statusCode).toBe(200);
      expect((await call("PATCH", "/me", { name: "", email: "bad" }, authed(token))).json().code).toBe("ValidationFailed");
      expect((await call("PATCH", "/me", { name: "Maya", email: valid.email })).statusCode).toBe(401);
    });
  });

  describe("POST /auth/change-password", () => {
    const change = (token: string, currentPassword: string, newPassword: string, cookie?: string) =>
      call("POST", "/change-password", { currentPassword, newPassword }, authed(token, cookie ? withCookie(cookie) : {}));

    it("changes the password: the old one stops working, the new one works", async () => {
      const { token, refreshToken } = await register();
      const res = await change(token, valid.password, "a-brand-new-password", refreshToken);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", data: null });
      expect((await post("/login", { email: valid.email, password: valid.password })).statusCode).toBe(401);
      expect((await post("/login", { email: valid.email, password: "a-brand-new-password" })).statusCode).toBe(200);
      expect(users.rows[0]?.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it("answers a wrong current password with 400 ValidationFailed on that field, NOT 401 (401 would sign the user out in the web app)", async () => {
      const { token } = await register();
      const res = await change(token, "not-my-password", "a-brand-new-password");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: "ValidationFailed",
        message: "Current password is incorrect.",
        error: { details: { fieldErrors: { currentPassword: ["Current password is incorrect."] } } },
      });
      expect((await post("/login", { email: valid.email, password: valid.password })).statusCode).toBe(200); // unchanged
    });

    it("signs out the other devices but keeps this one", async () => {
      const thisDevice = await register();
      const otherDevice = await post("/login", { email: valid.email, password: valid.password });
      await change(thisDevice.token, valid.password, "a-brand-new-password", thisDevice.refreshToken);
      expect((await call("POST", "/refresh", undefined, withCookie(refreshCookieOf(otherDevice)!.value))).statusCode).toBe(401);
      expect((await call("POST", "/refresh", undefined, withCookie(thisDevice.refreshToken))).statusCode).toBe(200);
    });

    it("validates the new password and needs a token", async () => {
      const { token } = await register();
      expect((await change(token, valid.password, "short")).json().error.details.fieldErrors).toHaveProperty("newPassword");
      expect((await call("POST", "/change-password", { currentPassword: "x", newPassword: "long-enough-1" })).statusCode).toBe(401);
    });
  });

  describe("DELETE /auth/me", () => {
    it("deletes the account, clears the cookie, and the old token stops working", async () => {
      const { token, refreshToken } = await register();
      const res = await call("DELETE", "/me", undefined, authed(token));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", message: "Account deleted.", data: null });
      expect(String(res.headers["set-cookie"])).toMatch(/dm_refresh=;/);
      expect(users.rows).toHaveLength(0);
      expect((await me(token)).statusCode).toBe(401);
      expect((await post("/login", { email: valid.email, password: valid.password })).statusCode).toBe(401);
      expect((await call("POST", "/refresh", undefined, withCookie(refreshToken))).statusCode).toBe(401);
    });

    it("needs a token", async () => {
      await register();
      expect((await call("DELETE", "/me")).statusCode).toBe(401);
      expect(users.rows).toHaveLength(1);
    });
  });
});
