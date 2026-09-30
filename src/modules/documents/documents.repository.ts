import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import { documents } from "../../database/schema";

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

/** All SQL for documents. Reads and writes are filtered by `userId` (every document row carries its owner). */
@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  list(userId: string, collectionId: string): Promise<DocumentRow[]> {
    return this.db
      .select()
      .from(documents)
      .where(and(eq(documents.collectionId, collectionId), eq(documents.userId, userId)))
      .orderBy(desc(documents.createdAt), desc(documents.id));
  }

  async countInCollection(collectionId: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(documents).where(eq(documents.collectionId, collectionId));
    return row?.n ?? 0;
  }

  async findByHash(collectionId: string, contentHash: string): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.collectionId, collectionId), eq(documents.contentHash, contentHash)))
      .limit(1);
    return row;
  }

  async findOwned(userId: string, id: string): Promise<DocumentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, userId)))
      .limit(1);
    return row;
  }

  async create(values: NewDocument): Promise<DocumentRow> {
    const [row] = await this.db.insert(documents).values(values).returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  }

  /** Back to the start of the pipeline (reprocess). */
  async markQueued(id: string): Promise<void> {
    await this.db.update(documents).set({ status: "queued", errorMessage: null, updatedAt: new Date() }).where(eq(documents.id, id));
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db.update(documents).set({ status: "failed", errorMessage, updatedAt: new Date() }).where(eq(documents.id, id));
  }

  /** Deletes one document (its chunks cascade). Returns its stored file path (or null) when a row was deleted, undefined when nothing was. */
  async delete(userId: string, id: string): Promise<{ storagePath: string | null } | undefined> {
    const [row] = await this.db
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, userId)))
      .returning({ storagePath: documents.storagePath });
    return row;
  }
}
