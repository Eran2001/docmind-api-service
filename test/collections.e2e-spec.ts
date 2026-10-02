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

// Real Postgres (the docmind_test database), real modules: only Redis and the AI service are left out.
// Skipped, not failed, when no database is reachable (start it with `npm run infra:up`).
describe.skipIf(!inject("dbReady"))("collections (real database)", () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        StorageModule,
        AuthModule,
        CollectionsModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createAdapter(),
      { logger: false },
    );
    await configureApp(app, loadEnv(process.env));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = moduleRef.get<Pool>(PG_POOL);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE users CASCADE"); // takes collections, documents, chunks, ... with it
  });

  const register = async (email: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { name: "Test User", email, password: "password123" },
    });
    return {
      token: res.json().data.accessToken as string,
      id: res.json().data.user.resourceId as string,
    };
  };
  const api = (
    token: string | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  // A create answers `{ result: true }` + the new id in `resourceId`; the record itself is fetched from the list.
  const create = async (token: string, name: string, description?: string) => {
    const res = await api(token, "POST", "/collections", { name, description });
    return { id: res.json().resourceId as string, name };
  };
  const getOne = async (token: string, id: string) =>
    (
      (await api(token, "GET", "/collections")).json().data.result as {
        resourceId: string;
        name: string;
        description: string | null;
        documentCount: number;
        createdAt: string;
        updatedAt: string;
      }[]
    ).find((c) => c.resourceId === id);
  const addDocument = (userId: string, collectionId: string, title: string) =>
    pool.query(
      `INSERT INTO documents (collection_id, user_id, source_type, title, status) VALUES ($1, $2, 'file', $3, 'ready')`,
      [collectionId, userId, title],
    );

  describe("POST /collections", () => {
    it("creates a collection: data is just { result: true } and the new id is the resourceId", async () => {
      const { token } = await register("a@test.com");
      const res = await api(token, "POST", "/collections", {
        name: "  Employee Handbook  ",
        description: "HR policies",
      });
      const body = res.json();
      expect(res.statusCode).toBe(201);
      expect(body).toMatchObject({
        code: "OK",
        message: "Collection created.",
        data: { result: true },
      });
      expect(body.data).toEqual({ result: true }); // the created record is NOT echoed back
      expect(body.resourceId).toMatch(/^[0-9a-f-]{36}$/);

      const stored = await getOne(token, body.resourceId);
      expect(stored).toHaveProperty("resourceId", body.resourceId);
      expect(stored).not.toHaveProperty("id"); // entities identify themselves as resourceId, never id
      expect(stored).toMatchObject({
        name: "Employee Handbook",
        description: "HR policies",
        documentCount: 0,
      });
      expect(new Date(stored!.createdAt).toISOString()).toBe(stored!.createdAt); // UTC ISO string
    });

    it("stores an empty or missing description as null", async () => {
      const { token } = await register("a@test.com");
      const a = await create(token, "A");
      const b = await create(token, "B", "   ");
      expect((await getOne(token, a.id))?.description).toBeNull();
      expect((await getOne(token, b.id))?.description).toBeNull();
    });

    it("validates the body", async () => {
      const { token } = await register("a@test.com");
      const bad = await api(token, "POST", "/collections", {
        name: " ",
        description: "x".repeat(501),
      });
      expect(bad.statusCode).toBe(400);
      expect(Object.keys(bad.json().error.details.fieldErrors).sort()).toEqual([
        "description",
        "name",
      ]);
      expect(
        (await api(token, "POST", "/collections", { name: "x".repeat(61) }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe("GET /collections", () => {
    it("returns only my collections, newest activity first, with a document count", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const first = await create(a.token, "First");
      await create(a.token, "Second");
      await create(b.token, "Not mine");
      await addDocument(a.id, first.id, "one.pdf");
      await addDocument(a.id, first.id, "two.pdf");
      await api(a.token, "PATCH", `/collections/${first.id}`, {
        name: "First (renamed)",
      }); // bumps updatedAt

      const res = await api(a.token, "GET", "/collections");
      expect(res.statusCode).toBe(200);
      const rows = res.json().data.result as {
        name: string;
        documentCount: number;
      }[];
      expect(rows.map((r) => r.name)).toEqual(["First (renamed)", "Second"]);
      expect(rows.map((r) => r.documentCount)).toEqual([2, 0]);
    });

    it("returns an empty result array when there are none", async () => {
      const { token } = await register("a@test.com");
      expect((await api(token, "GET", "/collections")).json().data).toEqual({
        result: [],
      });
    });

    it("filters with ?search= on name or description, ignoring case, and never on other users' data", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      await create(a.token, "Employee Handbook 2026", "Policies and benefits");
      await create(a.token, "Vendor Contracts", "Signed MSAs");
      await create(a.token, "API Docs", "Reference for the handbook API");
      await create(b.token, "Handbook (someone else)");

      const names = async (search: string) =>
        (
          (
            await api(
              a.token,
              "GET",
              `/collections?search=${encodeURIComponent(search)}`,
            )
          ).json().data.result as { name: string }[]
        )
          .map((r) => r.name)
          .sort();
      expect(await names("HANDBOOK")).toEqual([
        "API Docs",
        "Employee Handbook 2026",
      ]); // one by name, one by description
      expect(await names("msa")).toEqual(["Vendor Contracts"]);
      expect(await names("nothing like this")).toEqual([]);
      expect(await names("")).toHaveLength(3); // empty search = no filter
      expect(await names("   ")).toHaveLength(3);
    });

    it("treats % and _ in the search as plain characters, not wildcards", async () => {
      const { token } = await register("a@test.com");
      await create(token, "Q3 results");
      await create(token, "50% off list");
      await create(token, "snake_case notes");
      const names = async (search: string) =>
        (
          (
            await api(
              token,
              "GET",
              `/collections?search=${encodeURIComponent(search)}`,
            )
          ).json().data.result as { name: string }[]
        ).map((r) => r.name);
      expect(await names("%")).toEqual(["50% off list"]);
      expect(await names("_")).toEqual(["snake_case notes"]);
      expect(await names("50%")).toEqual(["50% off list"]);
    });

    it("rejects an over-long search", async () => {
      const { token } = await register("a@test.com");
      expect(
        (await api(token, "GET", `/collections?search=${"x".repeat(101)}`))
          .statusCode,
      ).toBe(400);
    });
  });

  describe("GET /collections/:id", () => {
    it("returns one of my collections with its document count", async () => {
      const a = await register("a@test.com");
      const { id } = await create(a.token, "Handbook", "HR");
      await addDocument(a.id, id, "x.pdf");
      const res = await api(a.token, "GET", `/collections/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        code: "OK",
        data: {
          resourceId: id,
          name: "Handbook",
          description: "HR",
          documentCount: 1,
        },
      });
    });

    it("answers 404 for someone else's, a missing or a malformed id", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const { id } = await create(a.token, "Private");
      for (const target of [
        id,
        "00000000-0000-4000-8000-000000000000",
        "nope",
      ]) {
        const res = await api(b.token, "GET", `/collections/${target}`);
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("NotFound");
      }
    });
  });

  describe("PATCH /collections/:id", () => {
    it("renames, changes and clears the description, and moves updatedAt forward", async () => {
      const { token } = await register("a@test.com");
      const { id } = await create(token, "Old name", "Old description");
      const before = (await getOne(token, id))!.updatedAt;
      await new Promise((r) => setTimeout(r, 15));

      const renamed = await api(token, "PATCH", `/collections/${id}`, {
        name: "New name",
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({
        code: "OK",
        message: "Collection updated.",
        resourceId: id,
        data: { result: true },
      });
      expect(renamed.json().data).toEqual({ result: true });
      const after = await getOne(token, id);
      expect(after).toMatchObject({
        name: "New name",
        description: "Old description",
      });
      expect(after!.updatedAt > before).toBe(true);

      await api(token, "PATCH", `/collections/${id}`, { description: "" });
      expect((await getOne(token, id))?.description).toBeNull();
      await api(token, "PATCH", `/collections/${id}`, {
        description: "Back again",
      });
      expect(await getOne(token, id)).toMatchObject({
        name: "New name",
        description: "Back again",
      });
    });

    it("rejects an empty or invalid patch", async () => {
      const { token } = await register("a@test.com");
      const { id } = await create(token, "Name");
      expect(
        (await api(token, "PATCH", `/collections/${id}`, {})).json().code,
      ).toBe("ValidationFailed");
      expect(
        (await api(token, "PATCH", `/collections/${id}`, { name: "" })).json()
          .code,
      ).toBe("ValidationFailed");
    });

    it("answers 404 for someone else's collection and changes nothing", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const { id } = await create(a.token, "Private");
      const res = await api(b.token, "PATCH", `/collections/${id}`, {
        name: "Hijacked",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        code: "NotFound",
        message: "Collection not found.",
      });
      expect(
        (await api(a.token, "GET", "/collections")).json().data.result[0].name,
      ).toBe("Private");
    });
  });

  describe("DELETE /collections/:id", () => {
    it("deletes the collection and cascades to its documents", async () => {
      const a = await register("a@test.com");
      const { id } = await create(a.token, "Doomed");
      await addDocument(a.id, id, "x.pdf");
      const res = await api(a.token, "DELETE", `/collections/${id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        code: "OK",
        message: "Collection deleted.",
        resourceId: id,
        data: { result: true },
      });
      expect(
        (await api(a.token, "GET", "/collections")).json().data.result,
      ).toEqual([]);
      expect(
        (await pool.query("SELECT count(*)::int AS n FROM documents")).rows[0]
          .n,
      ).toBe(0);
    });

    it("answers 404 for someone else's, a missing, or a malformed id, and deletes nothing", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const { id } = await create(a.token, "Keep me");
      for (const target of [
        id,
        "00000000-0000-4000-8000-000000000000",
        "not-a-uuid",
        "1' OR '1'='1",
      ]) {
        const res = await api(
          b.token,
          "DELETE",
          `/collections/${encodeURIComponent(target)}`,
        );
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("NotFound");
      }
      expect(
        (await api(a.token, "GET", "/collections")).json().data.result,
      ).toHaveLength(1);
    });

    it("deleting a user deletes their collections too", async () => {
      const a = await register("a@test.com");
      await create(a.token, "One");
      await api(a.token, "DELETE", "/auth/me");
      expect(
        (await pool.query("SELECT count(*)::int AS n FROM collections")).rows[0]
          .n,
      ).toBe(0);
    });
  });

  it("needs a token for every route", async () => {
    const { token } = await register("a@test.com");
    const { id } = await create(token, "Mine");
    for (const [method, url] of [
      ["GET", "/collections"],
      ["GET", `/collections/${id}`],
      ["POST", "/collections"],
      ["PATCH", `/collections/${id}`],
      ["DELETE", `/collections/${id}`],
    ] as const) {
      expect(
        (
          await api(
            null,
            method,
            url,
            method === "GET" || method === "DELETE" ? undefined : { name: "x" },
          )
        ).statusCode,
      ).toBe(401);
    }
  });
});
