import { Test, type TestingModule } from "@nestjs/testing";
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

import { ConfigModule } from "../../config/config.module";
import { DatabaseModule, PG_POOL } from "../../database/database.module";
import {
  DocumentsRepository,
  type IngestedChunk,
} from "./documents.repository";

describe.skipIf(!inject("dbReady"))(
  "DocumentsRepository ingestion transaction",
  () => {
    let repository: DocumentsRepository;
    let pool: Pool;
    let moduleRef: TestingModule;
    const userId = "00000000-0000-4000-8000-000000000011";
    const collectionId = "00000000-0000-4000-8000-000000000012";
    const documentId = "00000000-0000-4000-8000-000000000013";

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [ConfigModule, DatabaseModule],
        providers: [DocumentsRepository],
      }).compile();
      repository = moduleRef.get(DocumentsRepository);
      pool = moduleRef.get<Pool>(PG_POOL);
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    beforeEach(async () => {
      await pool.query("TRUNCATE users CASCADE");
      await pool.query(
        "INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)",
        [userId, "ingest-transaction@test.com", "test-hash", "Ingest test"],
      );
      await pool.query(
        "INSERT INTO collections (id, user_id, name) VALUES ($1, $2, $3)",
        [collectionId, userId, "Ingest test collection"],
      );
      await pool.query(
        "INSERT INTO documents (id, collection_id, user_id, source_type, title, status) VALUES ($1, $2, $3, 'file', 'test.txt', 'processing')",
        [documentId, collectionId, userId],
      );
    });

    it("commits chunks, usage and ready status together; a failed replacement rolls everything back", async () => {
      const goodChunk = chunk(
        "original text",
        Array.from({ length: 1536 }, () => 0.1),
      );
      const usage = {
        model: "test-embedding",
        input_tokens: 4,
        output_tokens: 0,
        latency_ms: 10,
      };

      await expect(
        repository.saveIngestResult(
          documentId,
          collectionId,
          userId,
          1,
          [goodChunk],
          usage,
        ),
      ).resolves.toBe(true);
      await expect(
        repository.saveIngestResult(
          documentId,
          collectionId,
          userId,
          2,
          [chunk("replacement", [0.2])],
          usage,
        ),
      ).rejects.toThrow();

      const document = await pool.query(
        "SELECT status, page_count, chunk_count FROM documents WHERE id = $1",
        [documentId],
      );
      const savedChunks = await pool.query(
        "SELECT content, page_number FROM chunks WHERE document_id = $1",
        [documentId],
      );
      const savedUsage = await pool.query(
        "SELECT model, kind FROM usage_events WHERE ref_id = $1",
        [documentId],
      );

      expect(document.rows[0]).toEqual({
        status: "ready",
        page_count: 1,
        chunk_count: 1,
      });
      expect(savedChunks.rows).toEqual([
        { content: "original text", page_number: 1 },
      ]);
      expect(savedUsage.rows).toEqual([
        { model: "test-embedding", kind: "embed" },
      ]);
    });
  },
);

function chunk(content: string, embedding: number[]): IngestedChunk {
  return {
    index: 0,
    content,
    page_number: 1,
    heading: null,
    token_count: 3,
    embedding,
  };
}
