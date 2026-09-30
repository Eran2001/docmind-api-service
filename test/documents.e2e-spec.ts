import { getQueueToken } from "@nestjs/bullmq";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

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
import { DocumentsController } from "../src/modules/documents/documents.controller";
import { DocumentsRepository } from "../src/modules/documents/documents.repository";
import { DocumentsService } from "../src/modules/documents/documents.service";

const config = loadEnv(process.env);
const STORAGE = resolve(config.STORAGE_DIR);

// Real Postgres (docmind_test) and real disk (./.test-storage); only the Redis queue is a stand-in.
describe.skipIf(!inject("dbReady"))("documents (real database and disk)", () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  const queue = { add: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, StorageModule, AuthModule, CollectionsModule],
      controllers: [DocumentsController],
      providers: [
        DocumentsRepository,
        DocumentsService,
        { provide: getQueueToken(QUEUES.INGEST), useValue: queue },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), { logger: false });
    await configureApp(app, config);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    pool = moduleRef.get<Pool>(PG_POOL);
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

  // ---- helpers ----
  const register = async (email: string) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { name: "Test User", email, password: "password123" } });
    return { token: res.json().data.accessToken as string, id: res.json().data.user.resourceId as string };
  };
  const call = (token: string | null, method: "GET" | "POST" | "DELETE", url: string, extra: { payload?: unknown; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      payload: extra.payload as never,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra.headers },
    });
  const newCollection = async (token: string, name = "Handbook") =>
    (await call(token, "POST", "/collections", { payload: { name } })).json().resourceId as string;

  const multipart = (filename: string, content: Buffer, field = "file") => {
    const boundary = `----docmind${Math.random().toString(16).slice(2)}`;
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    return {
      payload: Buffer.concat([Buffer.from(head), content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    };
  };
  const upload = (token: string | null, collectionId: string, filename: string, content: Buffer, field = "file") =>
    call(token, "POST", `/collections/${collectionId}/documents`, multipart(filename, content, field));
  const list = async (token: string, collectionId: string) =>
    (await call(token, "GET", `/collections/${collectionId}/documents`)).json().data.result as {
      resourceId: string;
      title: string;
      status: string;
      sourceType: string;
      mimeType: string | null;
      sizeBytes: number | null;
      sourceUrl: string | null;
      errorMessage: string | null;
    }[];

  const pdf = (marker = "a") => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${marker}\n%%EOF`);
  const docx = (marker = "a") => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`word/document.xml ${marker}`)]);
  const text = (marker = "a") => Buffer.from(`Policies and benefits. ${marker}\nThis is plain text with ünïcode.`);
  const filesOnDisk = () => (existsSync(STORAGE) ? readdirSync(STORAGE, { recursive: true }).filter((f) => /\.[a-z]+$/.test(String(f))) : []);

  describe("POST /collections/:id/documents (upload)", () => {
    it("saves a PDF, records it as queued, queues the ingest job, and answers 202 { result: true } with the new id", async () => {
      const { token, id: userId } = await register("a@test.com");
      const cid = await newCollection(token);
      const res = await upload(token, cid, "Employee Handbook.pdf", pdf());
      const body = res.json();
      expect(res.statusCode).toBe(202);
      expect(body).toMatchObject({ code: "OK", message: "Document queued for processing.", data: { result: true } });
      expect(body.data).toEqual({ result: true });
      expect(body.resourceId).toMatch(/^[0-9a-f-]{36}$/);

      const [doc] = await list(token, cid);
      expect(doc).toMatchObject({ resourceId: body.resourceId, title: "Employee Handbook.pdf", status: "queued", sourceType: "file", mimeType: "application/pdf", sizeBytes: pdf().length });
      // on disk under <userId>/<documentId>.pdf, named by us, not by the upload
      expect(existsSync(join(STORAGE, userId, `${body.resourceId}.pdf`))).toBe(true);
      expect(queue.add).toHaveBeenCalledWith("ingest", { documentId: body.resourceId }, expect.objectContaining({ attempts: 4 }));
    });

    it("accepts DOCX, TXT and MD too, and the collection's documentCount follows", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      for (const [name, content] of [["a.docx", docx()], ["b.txt", text("b")], ["c.md", text("c")]] as const) {
        expect((await upload(token, cid, name, content)).statusCode).toBe(202);
      }
      const docs = await list(token, cid);
      expect(docs.map((d) => d.mimeType).sort()).toEqual([
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/markdown",
        "text/plain",
      ]);
      expect((await call(token, "GET", `/collections/${cid}`)).json().data.documentCount).toBe(3);
    });

    it("decides by the file's bytes, not its name: a fake PDF, a text file named .pdf, a fake DOCX, a binary .txt and an .exe are all refused", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      const cases: [string, Buffer][] = [
        ["virus.pdf", Buffer.from("MZ\x90\x00 not a pdf at all")],
        ["notes.pdf", text()],
        ["report.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("just a zip, no word files")])],
        ["binary.txt", Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])],
        ["setup.exe", Buffer.from("MZ....")],
        ["image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ];
      for (const [name, content] of cases) {
        const res = await upload(token, cid, name, content);
        expect(res.statusCode, name).toBe(400);
        expect(res.json(), name).toMatchObject({ code: "ValidationFailed", error: { details: { fieldErrors: { file: [expect.any(String)] } } } });
      }
      expect(await list(token, cid)).toHaveLength(0);
      expect(filesOnDisk()).toHaveLength(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("refuses an empty file, a missing file field, a non-multipart body and an over-size file", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      expect((await upload(token, cid, "empty.txt", Buffer.alloc(0))).json().message).toBe("That file is empty.");
      expect((await upload(token, cid, "x.pdf", pdf(), "wrongfield")).statusCode).toBe(400);
      expect((await call(token, "POST", `/collections/${cid}/documents`, { payload: { file: "x" } })).json().code).toBe("ValidationFailed");
      const big = Buffer.concat([pdf(), Buffer.alloc(config.MAX_UPLOAD_MB * 1024 * 1024 + 10, "x")]);
      const tooBig = await upload(token, cid, "big.pdf", big);
      expect(tooBig.statusCode).toBe(400);
      expect(tooBig.json().message).toBe(`That file is larger than ${config.MAX_UPLOAD_MB} MB.`);
      expect(filesOnDisk()).toHaveLength(0);
    });

    it("rejects the same bytes in the same collection (409 DuplicateDocument) even under another name, but allows them in another collection", async () => {
      const { token } = await register("a@test.com");
      const one = await newCollection(token, "One");
      const two = await newCollection(token, "Two");
      await upload(token, one, "first.pdf", pdf("same"));
      const dup = await upload(token, one, "renamed.pdf", pdf("same"));
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ code: "DuplicateDocument" });
      expect(await list(token, one)).toHaveLength(1);
      expect(filesOnDisk()).toHaveLength(1); // the duplicate was not left on disk
      expect((await upload(token, two, "first.pdf", pdf("same"))).statusCode).toBe(202);
    });

    it("stops at 50 documents per collection (422 LimitReached)", async () => {
      const { token, id: userId } = await register("a@test.com");
      const cid = await newCollection(token);
      await pool.query(
        `INSERT INTO documents (collection_id, user_id, source_type, title, content_hash)
         SELECT $1, $2, 'file', 'doc ' || g, 'hash-' || g FROM generate_series(1, 50) g`,
        [cid, userId],
      );
      const res = await upload(token, cid, "one-too-many.pdf", pdf("51"));
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "LimitReached" });
      expect(filesOnDisk()).toHaveLength(0);
    });

    it("never uses a path from the upload: a hostile filename stays a harmless title", async () => {
      const { token, id: userId } = await register("a@test.com");
      const cid = await newCollection(token);
      const res = await upload(token, cid, "../../../etc/passwd.txt", text());
      expect(res.statusCode).toBe(202);
      expect((await list(token, cid))[0]?.title).toBe("passwd.txt");
      expect(existsSync(join(STORAGE, userId, `${res.json().resourceId}.txt`))).toBe(true);
      expect(existsSync(resolve(STORAGE, "..", "..", "etc"))).toBe(false);
    });

    it("answers 404 for someone else's or a malformed collection, and needs a token", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const cid = await newCollection(a.token);
      expect((await upload(b.token, cid, "x.pdf", pdf())).statusCode).toBe(404);
      expect((await upload(b.token, "nope", "x.pdf", pdf())).statusCode).toBe(404);
      expect((await upload(null, cid, "x.pdf", pdf())).statusCode).toBe(401);
      expect(filesOnDisk()).toHaveLength(0);
    });

    it("undoes everything and answers 503 when the queue can't take the job", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      queue.add.mockRejectedValueOnce(new Error("redis down"));
      const res = await upload(token, cid, "x.pdf", pdf());
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("ServiceUnavailable");
      expect(await list(token, cid)).toHaveLength(0);
      expect(filesOnDisk()).toHaveLength(0);
    });
  });

  describe("POST /collections/:id/documents/url", () => {
    const addUrl = (token: string | null, cid: string, url: unknown) => call(token, "POST", `/collections/${cid}/documents/url`, { payload: { url } });

    it("queues a web page: 202 { result: true }, stored as a url document", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      const res = await addUrl(token, cid, "  https://Docs.Acme.com/benefits#section  ");
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ code: "OK", message: "URL queued for processing.", data: { result: true } });
      const [doc] = await list(token, cid);
      expect(doc).toMatchObject({ sourceType: "url", sourceUrl: "https://docs.acme.com/benefits", title: "docs.acme.com/benefits", status: "queued", mimeType: null });
      expect(queue.add).toHaveBeenCalledWith("ingest", { documentId: res.json().resourceId }, expect.any(Object));
    });

    it("rejects anything that isn't a full http(s) URL", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      for (const bad of ["docs.acme.com", "ftp://x.com/file", "javascript:alert(1)", "not a url", "", 42]) {
        const res = await addUrl(token, cid, bad);
        expect(res.statusCode, String(bad)).toBe(400);
        expect(res.json().code).toBe("ValidationFailed");
      }
    });

    it("treats the same page as a duplicate however it is written (case, #fragment)", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      await addUrl(token, cid, "https://docs.acme.com/benefits");
      for (const again of ["https://DOCS.acme.com/benefits", "https://docs.acme.com/benefits#top"]) {
        const res = await addUrl(token, cid, again);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("DuplicateDocument");
      }
      expect(await list(token, cid)).toHaveLength(1);
    });

    it("404 for someone else's collection; 503 and no leftover row when the queue is down", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const cid = await newCollection(a.token);
      expect((await addUrl(b.token, cid, "https://x.com/a")).statusCode).toBe(404);
      queue.add.mockRejectedValueOnce(new Error("redis down"));
      expect((await addUrl(a.token, cid, "https://x.com/a")).statusCode).toBe(503);
      expect(await list(a.token, cid)).toHaveLength(0);
    });
  });

  describe("GET /collections/:id/documents", () => {
    it("lists only my collection's documents, newest first, and 404s for someone else's", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const cid = await newCollection(a.token);
      await upload(a.token, cid, "first.txt", text("1"));
      await new Promise((r) => setTimeout(r, 10));
      await upload(a.token, cid, "second.txt", text("2"));
      expect((await list(a.token, cid)).map((d) => d.title)).toEqual(["second.txt", "first.txt"]);
      expect((await call(b.token, "GET", `/collections/${cid}/documents`)).statusCode).toBe(404);
      expect((await call(null, "GET", `/collections/${cid}/documents`)).statusCode).toBe(401);
    });

    it("returns an empty result array for an empty collection", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      expect((await call(token, "GET", `/collections/${cid}/documents`)).json().data).toEqual({ result: [] });
    });
  });

  describe("POST /documents/:id/reprocess", () => {
    it("puts a failed document back in the queue and clears its error", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      const docId = (await upload(token, cid, "x.txt", text())).json().resourceId as string;
      await pool.query("UPDATE documents SET status = 'failed', error_message = 'Could not parse' WHERE id = $1", [docId]);
      queue.add.mockClear();

      const res = await call(token, "POST", `/documents/${docId}/reprocess`);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ code: "OK", resourceId: docId, data: { result: true } });
      expect((await list(token, cid))[0]).toMatchObject({ status: "queued", errorMessage: null });
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it("leaves a document that is already queued or processing alone", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      const docId = (await upload(token, cid, "x.txt", text())).json().resourceId as string;
      queue.add.mockClear();
      expect((await call(token, "POST", `/documents/${docId}/reprocess`)).statusCode).toBe(202);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("marks the document failed again (with a message) if the queue is down, and 404s for someone else's", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const cid = await newCollection(a.token);
      const docId = (await upload(a.token, cid, "x.txt", text())).json().resourceId as string;
      await pool.query("UPDATE documents SET status = 'failed', error_message = 'old' WHERE id = $1", [docId]);
      expect((await call(b.token, "POST", `/documents/${docId}/reprocess`)).statusCode).toBe(404);
      queue.add.mockRejectedValueOnce(new Error("redis down"));
      expect((await call(a.token, "POST", `/documents/${docId}/reprocess`)).statusCode).toBe(503);
      expect((await list(a.token, cid))[0]).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("Couldn't queue") });
    });
  });

  describe("DELETE /documents/:id", () => {
    it("deletes the document, its file on disk, and updates the collection's count", async () => {
      const { token } = await register("a@test.com");
      const cid = await newCollection(token);
      const docId = (await upload(token, cid, "x.pdf", pdf())).json().resourceId as string;
      expect(filesOnDisk()).toHaveLength(1);

      const res = await call(token, "DELETE", `/documents/${docId}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ code: "OK", message: "Document deleted.", resourceId: docId, data: { result: true } });
      expect(await list(token, cid)).toHaveLength(0);
      expect(filesOnDisk()).toHaveLength(0);
      expect((await call(token, "GET", `/collections/${cid}`)).json().data.documentCount).toBe(0);
    });

    it("404 for someone else's, a missing or a malformed id, and deletes nothing", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      const cid = await newCollection(a.token);
      const docId = (await upload(a.token, cid, "x.pdf", pdf())).json().resourceId as string;
      for (const target of [docId, "00000000-0000-4000-8000-000000000000", "nope"]) {
        expect((await call(b.token, "DELETE", `/documents/${target}`)).statusCode).toBe(404);
      }
      expect(await list(a.token, cid)).toHaveLength(1);
      expect(filesOnDisk()).toHaveLength(1);
      expect((await call(null, "DELETE", `/documents/${docId}`)).statusCode).toBe(401);
    });
  });

  describe("cleaning up files", () => {
    it("deleting a collection deletes its files from disk", async () => {
      const { token } = await register("a@test.com");
      const keep = await newCollection(token, "Keep");
      const doomed = await newCollection(token, "Doomed");
      await upload(token, keep, "keep.pdf", pdf("keep"));
      await upload(token, doomed, "a.pdf", pdf("a"));
      await upload(token, doomed, "b.txt", text("b"));
      expect(filesOnDisk()).toHaveLength(3);
      expect((await call(token, "DELETE", `/collections/${doomed}`)).statusCode).toBe(200);
      expect(filesOnDisk()).toHaveLength(1);
      expect((await pool.query("SELECT count(*)::int AS n FROM documents")).rows[0].n).toBe(1);
    });

    it("deleting the account deletes all of the user's files and leaves other users' files alone", async () => {
      const a = await register("a@test.com");
      const b = await register("b@test.com");
      await upload(a.token, await newCollection(a.token), "a.pdf", pdf("a"));
      await upload(b.token, await newCollection(b.token), "b.pdf", pdf("b"));
      expect(filesOnDisk()).toHaveLength(2);
      expect((await call(a.token, "DELETE", "/auth/me")).statusCode).toBe(200);
      expect(existsSync(join(STORAGE, a.id))).toBe(false);
      expect(existsSync(join(STORAGE, b.id))).toBe(true);
      expect(filesOnDisk()).toHaveLength(1);
    });
  });
});
