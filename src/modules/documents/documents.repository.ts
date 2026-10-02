import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import { chunks, documents, usageEvents } from "../../database/schema";
import { costUsd } from "../usage/pricing";

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

export interface IngestedChunk {
  index: number;
  content: string;
  page_number: number | null;
  heading: string | null;
  token_count: number;
  embedding: number[];
}

export interface EmbeddingUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

/** All SQL for documents. Reads and writes are filtered by `userId` (every document row carries its owner). */
@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  list(userId: string, collectionId: string): Promise<DocumentRow[]> {
    return this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.collectionId, collectionId),
          eq(documents.userId, userId),
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.id));
  }

  async countInCollection(collectionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(documents)
      .where(eq(documents.collectionId, collectionId));
    return row?.n ?? 0;
  }

  async findByHash(
    collectionId: string,
    contentHash: string,
  ): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.collectionId, collectionId),
          eq(documents.contentHash, contentHash),
        ),
      )
      .limit(1);
    return row;
  }

  async findOwned(
    userId: string,
    id: string,
  ): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, userId)))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return row;
  }

  async findChunkDetail(userId: string, documentId: string, chunkId: string) {
    const [row] = await this.db
      .select({
        id: chunks.id,
        documentId: chunks.documentId,
        documentTitle: documents.title,
        sourceType: documents.sourceType,
        pageNumber: chunks.pageNumber,
        heading: chunks.heading,
        content: chunks.content,
        chunkIndex: chunks.chunkIndex,
      })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(
        and(
          eq(chunks.id, chunkId),
          eq(chunks.documentId, documentId),
          eq(documents.userId, userId),
        ),
      )
      .limit(1);
    if (!row) return undefined;

    const [previous] = await this.db
      .select({ content: chunks.content })
      .from(chunks)
      .where(
        and(
          eq(chunks.documentId, documentId),
          sql`${chunks.chunkIndex} < ${row.chunkIndex}`,
        ),
      )
      .orderBy(desc(chunks.chunkIndex))
      .limit(1);
    const [next] = await this.db
      .select({ content: chunks.content })
      .from(chunks)
      .where(
        and(
          eq(chunks.documentId, documentId),
          sql`${chunks.chunkIndex} > ${row.chunkIndex}`,
        ),
      )
      .orderBy(chunks.chunkIndex)
      .limit(1);
    const [total] = await this.db
      .select({ value: count() })
      .from(chunks)
      .where(eq(chunks.documentId, documentId));

    return {
      ...row,
      sourceType: row.sourceType as "file" | "url",
      contextBefore: previous?.content ?? "",
      contextAfter: next?.content ?? "",
      chunkCount: total?.value ?? 0,
    };
  }

  async create(values: NewDocument): Promise<DocumentRow> {
    const [row] = await this.db.insert(documents).values(values).returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  }

  /** Back to the start of the pipeline (reprocess). */
  async markQueued(id: string): Promise<void> {
    await this.db
      .update(documents)
      .set({ status: "queued", errorMessage: null, updatedAt: new Date() })
      .where(eq(documents.id, id));
  }

  async markProcessing(id: string): Promise<boolean> {
    const rows = await this.db
      .update(documents)
      .set({ status: "processing", errorMessage: null, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning({ id: documents.id });
    return rows.length > 0;
  }

  /** Replaces chunks, records embedding usage, and marks the document ready as one atomic operation. */
  async saveIngestResult(
    documentId: string,
    collectionId: string,
    userId: string,
    pageCount: number | null,
    result: IngestedChunk[],
    usage: EmbeddingUsage,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(documents)
        .set({
          status: "ready",
          errorMessage: null,
          pageCount,
          chunkCount: result.length,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId))
        .returning({ id: documents.id });
      if (updated.length === 0) return false;

      await tx.delete(chunks).where(eq(chunks.documentId, documentId));
      for (let start = 0; start < result.length; start += 200) {
        const batch = result.slice(start, start + 200);
        await tx.insert(chunks).values(
          batch.map((chunk) => ({
            documentId,
            collectionId,
            chunkIndex: chunk.index,
            content: chunk.content,
            pageNumber: chunk.page_number,
            heading: chunk.heading,
            tokenCount: chunk.token_count,
            embedding: chunk.embedding,
          })),
        );
      }
      await tx.insert(usageEvents).values({
        userId,
        kind: "embed",
        model: usage.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        costUsd: String(
          costUsd(usage.model, usage.input_tokens, usage.output_tokens),
        ),
        latencyMs: usage.latency_ms,
        refType: "document",
        refId: documentId,
      });
      return true;
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db
      .update(documents)
      .set({ status: "failed", errorMessage, updatedAt: new Date() })
      .where(eq(documents.id, id));
  }

  /** Deletes one document (its chunks cascade). Returns its stored file path (or null) when a row was deleted, undefined when nothing was. */
  async delete(
    userId: string,
    id: string,
  ): Promise<{ storagePath: string | null } | undefined> {
    const [row] = await this.db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, userId)))
      .returning({ storagePath: documents.storagePath });
    return row;
  }
}
