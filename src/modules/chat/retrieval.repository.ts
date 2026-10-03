import { Inject, Injectable } from "@nestjs/common";
import { count, desc, eq, sql } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import { collections, documents } from "../../database/schema";
import type { LibraryOverview } from "./intents";
import { RETRIEVAL } from "../../config/constants";

export interface RetrievedChunk extends Record<string, unknown> {
  id: string;
  content: string;
  pageNumber: number | null;
  heading: string | null;
  documentId: string;
  documentTitle: string;
  score: number;
  /** Cosine similarity to the question, 0..1 (1 = same direction). */
  similarity: number;
  /** True when the passage also matched the question's words in the keyword search. */
  keywordHit: boolean;
}

@Injectable()
export class RetrievalRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async readyDocumentCount(collectionId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(documents)
      .where(
        sql`${documents.collectionId} = ${collectionId} AND ${documents.status} = 'ready'`,
      );
    return row?.value ?? 0;
  }

  async search(
    collectionId: string,
    embedding: number[],
    rawQuery: string,
    topK: number = RETRIEVAL.TOP_K,
  ): Promise<RetrievedChunk[]> {
    const vector = `[${embedding.join(",")}]`;
    const result = await this.db.execute<RetrievedChunk>(sql`
      WITH vector_search AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.embedding <=> ${vector}::vector) AS rank
        FROM chunks c
        JOIN documents d ON d.id = c.document_id AND d.status = 'ready'
        WHERE c.collection_id = ${collectionId}
        ORDER BY c.embedding <=> ${vector}::vector
        LIMIT ${RETRIEVAL.CANDIDATES}
      ),
      keyword_and AS (
        -- ALL of the question's words match: a precise signal, so it gets its own list and extra weight in the fusion.
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, q.query) DESC) AS rank
        FROM chunks c
        JOIN documents d ON d.id = c.document_id AND d.status = 'ready'
        CROSS JOIN (SELECT websearch_to_tsquery('english', ${rawQuery}) AS query) AS q
        WHERE c.collection_id = ${collectionId} AND c.tsv @@ q.query
        ORDER BY ts_rank_cd(c.tsv, q.query) DESC
        LIMIT ${RETRIEVAL.CANDIDATES}
      ),
      keyword_or AS (
        -- ANY of the question's words may match (ranked by how many and how well). With all-words-must-match alone, a
        -- natural-language question rarely finds anything. Docs benchmark, top-8 hit: 82% -> 91%, ranking (MRR) 0.52 -> 0.58.
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, q.query) DESC) AS rank
        FROM chunks c
        JOIN documents d ON d.id = c.document_id AND d.status = 'ready'
        CROSS JOIN (
          SELECT replace(plainto_tsquery('english', ${rawQuery})::text, '&', '|')::tsquery AS query
        ) AS q
        WHERE c.collection_id = ${collectionId} AND c.tsv @@ q.query
        ORDER BY ts_rank_cd(c.tsv, q.query) DESC
        LIMIT ${RETRIEVAL.CANDIDATES}
      ),
      fused AS (
        SELECT id, SUM(1.0 / (${RETRIEVAL.RRF_K} + rank)) AS score
        FROM (
          SELECT * FROM vector_search UNION ALL SELECT * FROM keyword_and UNION ALL SELECT * FROM keyword_or
        ) candidates
        GROUP BY id
      )
      SELECT c.id, c.content, c.page_number AS "pageNumber", c.heading,
        c.document_id AS "documentId", d.title AS "documentTitle", fused.score,
        (1 - (c.embedding <=> ${vector}::vector)) AS similarity,
        -- Strict: ALL of the question's words are in the passage. This (not the loose search above) is what tells
        -- the relevance gate that a passage really matches the question.
        (c.tsv @@ websearch_to_tsquery('english', ${rawQuery})) AS "keywordHit"
      FROM fused
      JOIN chunks c ON c.id = fused.id
      JOIN documents d ON d.id = c.document_id
      ORDER BY fused.score DESC
      LIMIT ${topK}
    `);
    return result.rows.map((row) => ({
      ...row,
      score: Number(row.score),
      similarity: Number(row.similarity),
    }));
  }

  /** The collection's name and its documents (newest first), for answers about the library itself. */
  async collectionOverview(collectionId: string): Promise<LibraryOverview> {
    const [collection] = await this.db
      .select({ name: collections.name })
      .from(collections)
      .where(eq(collections.id, collectionId))
      .limit(1);
    const rows = await this.db
      .select({ title: documents.title, status: documents.status })
      .from(documents)
      .where(eq(documents.collectionId, collectionId))
      .orderBy(desc(documents.createdAt), desc(documents.id));
    return { name: collection?.name ?? "this collection", documents: rows };
  }
}
