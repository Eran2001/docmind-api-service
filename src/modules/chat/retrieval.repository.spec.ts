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
import { RetrievalRepository } from "./retrieval.repository";

describe.skipIf(!inject("dbReady"))("RetrievalRepository", () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let retrieval: RetrievalRepository;
  const userId = "00000000-0000-4000-8000-000000000201";
  const collectionId = "00000000-0000-4000-8000-000000000202";
  const readyDocumentId = "00000000-0000-4000-8000-000000000203";
  const processingDocumentId = "00000000-0000-4000-8000-000000000204";

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
      providers: [RetrievalRepository],
    }).compile();
    pool = moduleRef.get<Pool>(PG_POOL);
    retrieval = moduleRef.get(RetrievalRepository);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE users CASCADE");
    await pool.query(
      "INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)",
      [userId, "retrieval@test.com", "test-hash", "Retrieval test"],
    );
    await pool.query(
      "INSERT INTO collections (id, user_id, name) VALUES ($1, $2, $3)",
      [collectionId, userId, "Retrieval test collection"],
    );
    await pool.query(
      "INSERT INTO documents (id, collection_id, user_id, source_type, title, status) VALUES ($1, $2, $3, 'file', 'Ready policy', 'ready'), ($4, $2, $3, 'file', 'Processing policy', 'processing')",
      [readyDocumentId, collectionId, userId, processingDocumentId],
    );
    const vector = `[${Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)).join(",")}]`;
    await pool.query(
      "INSERT INTO chunks (document_id, collection_id, chunk_index, content, page_number, heading, token_count, embedding) VALUES ($1, $2, 0, $3, 2, 'Refunds', 8, $4::vector), ($5, $2, 0, 'PRIVATE PROCESSING ONLY', 1, NULL, 5, $4::vector)",
      [
        readyDocumentId,
        collectionId,
        "Refunds are accepted within thirty days of delivery.",
        vector,
        processingDocumentId,
      ],
    );
  });

  it("uses hybrid search and excludes chunks until their document is ready", async () => {
    const vector = Array.from({ length: 1536 }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    expect(await retrieval.readyDocumentCount(collectionId)).toBe(1);
    const results = await retrieval.search(
      collectionId,
      vector,
      "refunds within thirty days",
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: expect.any(String),
      content: "Refunds are accepted within thirty days of delivery.",
      pageNumber: 2,
      heading: "Refunds",
      documentId: readyDocumentId,
      documentTitle: "Ready policy",
    });
    expect(results[0]?.score).toBeGreaterThan(0);
    // The question vector is the chunk's own vector (similarity 1) and its words match the passage.
    expect(results[0]?.similarity).toBeCloseTo(1, 5);
    expect(results[0]?.keywordHit).toBe(true);
  });

  it("finds a passage when only SOME of the question's words match, but does not call that a keyword hit", async () => {
    // A vector that points nowhere near the stored chunk, so only the keyword search can find it.
    const farAway = Array.from({ length: 1536 }, (_, index) =>
      index === 1 ? 1 : 0,
    );

    const results = await retrieval.search(
      collectionId,
      farAway,
      "what is the refunds policy on spaceships",
    );

    expect(results.map((r) => r.documentTitle)).toContain("Ready policy");
    const found = results.find((r) => r.documentTitle === "Ready policy");
    expect(found?.keywordHit).toBe(false); // "spaceships" is not in the passage
  });

  it("reports similarity without a keyword hit when only the meaning matches", async () => {
    const vector = Array.from({ length: 1536 }, (_, index) =>
      index === 0 ? 1 : 0,
    );

    const results = await retrieval.search(collectionId, vector, "zzzxqj");

    expect(results[0]?.similarity).toBeCloseTo(1, 5);
    expect(results[0]?.keywordHit).toBe(false);
  });

  it("describes the collection and its documents, including unfinished ones", async () => {
    const overview = await retrieval.collectionOverview(collectionId);

    expect(overview.name).toBe("Retrieval test collection");
    expect(overview.documents).toEqual(
      expect.arrayContaining([
        { title: "Ready policy", status: "ready" },
        { title: "Processing policy", status: "processing" },
      ]),
    );
    expect(overview.documents).toHaveLength(2);
  });
});
