import { Inject, Injectable } from "@nestjs/common";
import { count } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import { documents } from "../../database/schema";
import { RETRIEVAL } from "../../config/constants";

export interface RetrievedChunk extends Record<string, unknown> {
  id: string;
  content: string;
  pageNumber: number | null;
  heading: string | null;
  documentId: string;
  documentTitle: string;
  score: number;
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
      keyword_search AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, q.query) DESC) AS rank
        FROM chunks c
        JOIN documents d ON d.id = c.document_id AND d.status = 'ready'
        CROSS JOIN websearch_to_tsquery('english', ${rawQuery}) AS q(query)
        WHERE c.collection_id = ${collectionId} AND c.tsv @@ q.query
        ORDER BY ts_rank_cd(c.tsv, q.query) DESC
        LIMIT ${RETRIEVAL.CANDIDATES}
      ),
      fused AS (
        SELECT id, SUM(1.0 / (${RETRIEVAL.RRF_K} + rank)) AS score
        FROM (SELECT * FROM vector_search UNION ALL SELECT * FROM keyword_search) candidates
        GROUP BY id
      )
      SELECT c.id, c.content, c.page_number AS "pageNumber", c.heading,
        c.document_id AS "documentId", d.title AS "documentTitle", fused.score
      FROM fused
      JOIN chunks c ON c.id = fused.id
      JOIN documents d ON d.id = c.document_id
      ORDER BY fused.score DESC
      LIMIT ${topK}
    `);
    return result.rows.map((row) => ({ ...row, score: Number(row.score) }));
  }
}
