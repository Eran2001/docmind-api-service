import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import { collections, documents } from "../../database/schema";

export interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Every collection is returned with how many documents it holds.
const columns = {
  id: collections.id,
  name: collections.name,
  description: collections.description,
  createdAt: collections.createdAt,
  updatedAt: collections.updatedAt,
  // The table names are written out on purpose: inside a select Drizzle prints columns WITHOUT their table, and
  // the subquery would compare the documents table with itself (always 0).
  documentCount: sql<number>`(select count(*)::int from "documents" where "documents"."collection_id" = "collections"."id")`,
};

/** `%` and `_` are wildcards in LIKE; escape them so a search for "50%" means those characters. */
const containsPattern = (term: string) =>
  `%${term.replace(/[\\%_]/g, "\\$&")}%`;

/** All SQL for collections. Every query is filtered by `userId`: someone else's collection simply isn't there. */
@Injectable()
export class CollectionsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  list(userId: string, search?: string): Promise<CollectionRow[]> {
    const match = search
      ? or(
          ilike(collections.name, containsPattern(search)),
          ilike(collections.description, containsPattern(search)),
        )
      : undefined;
    return this.db
      .select(columns)
      .from(collections)
      .where(and(eq(collections.userId, userId), match))
      .orderBy(desc(collections.updatedAt), desc(collections.createdAt));
  }

  async findOwned(
    userId: string,
    id: string,
  ): Promise<CollectionRow | undefined> {
    const [row] = await this.db
      .select(columns)
      .from(collections)
      .where(and(eq(collections.id, id), eq(collections.userId, userId)))
      .limit(1);
    return row;
  }

  async create(
    userId: string,
    input: { name: string; description: string | null },
  ): Promise<CollectionRow> {
    const [created] = await this.db
      .insert(collections)
      .values({ userId, ...input })
      .returning({ id: collections.id });
    const row = created && (await this.findOwned(userId, created.id));
    if (!row) throw new Error("Insert returned no row");
    return row;
  }

  async update(
    userId: string,
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<CollectionRow | undefined> {
    const updated = await this.db
      .update(collections)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(collections.id, id), eq(collections.userId, userId)))
      .returning({ id: collections.id });
    return updated[0] ? this.findOwned(userId, id) : undefined;
  }

  /** Stored file paths of a collection's documents, read before deleting it (the rows go with it). */
  async storagePaths(userId: string, id: string): Promise<(string | null)[]> {
    const rows = await this.db
      .select({ path: documents.storagePath })
      .from(documents)
      .where(and(eq(documents.collectionId, id), eq(documents.userId, userId)));
    return rows.map((r) => r.path);
  }

  /** True if a collection was deleted. Its documents, chunks and conversations go with it (foreign-key cascade). */
  async delete(userId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(collections)
      .where(and(eq(collections.id, id), eq(collections.userId, userId)))
      .returning({ id: collections.id });
    return deleted.length > 0;
  }
}
