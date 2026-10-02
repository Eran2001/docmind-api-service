import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { DB, type Database } from "../../database/database.module";
import {
  collections,
  documents,
  evalQuestions,
  evalSets,
  users,
} from "../../database/schema";
import type { UserRow } from "../users/users.repository";

export interface TemplateDocument {
  id: string;
  storagePath: string | null;
}

@Injectable()
export class DemoRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async activeDemoCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(users)
      .where(eq(users.isDemo, true));
    return row?.n ?? 0;
  }

  /** The seeded account's sample collection, if it exists and all its documents are ready. */
  async findTemplate(
    email: string,
    collectionName: string,
  ): Promise<{ collectionId: string } | undefined> {
    const [row] = await this.db
      .select({ collectionId: collections.id })
      .from(collections)
      .innerJoin(users, eq(users.id, collections.userId))
      .where(and(eq(users.email, email), eq(collections.name, collectionName)))
      .limit(1);
    if (!row) return undefined;
    const [pending] = await this.db
      .select({ n: count() })
      .from(documents)
      .where(
        and(
          eq(documents.collectionId, row.collectionId),
          sql`${documents.status} <> 'ready'`,
        ),
      );
    const [ready] = await this.db
      .select({ n: count() })
      .from(documents)
      .where(
        and(
          eq(documents.collectionId, row.collectionId),
          eq(documents.status, "ready"),
        ),
      );
    return (pending?.n ?? 0) === 0 && (ready?.n ?? 0) > 0 ? row : undefined;
  }

  /**
   * Creates the demo user and copies the template into it, all in one transaction: the collection, its documents with
   * their chunks (embeddings included, so nothing is re-processed), and the eval set with its questions.
   * `copyFile` copies the stored file of one document and returns the new path; it runs inside the transaction so a failure rolls back.
   */
  async createSandbox(input: {
    email: string;
    name: string;
    passwordHash: string;
    templateCollectionId: string;
    copyFile: (
      fromPath: string,
      userId: string,
      documentId: string,
      extension: string,
    ) => Promise<string>;
  }): Promise<{ user: UserRow; copiedPaths: string[] }> {
    const copiedPaths: string[] = [];
    try {
      const user = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({
            email: input.email,
            name: input.name,
            passwordHash: input.passwordHash,
            isDemo: true,
          })
          .returning();
        if (!created) throw new Error("Insert returned no user");

        const [templateCollection] = await tx
          .select()
          .from(collections)
          .where(eq(collections.id, input.templateCollectionId))
          .limit(1);
        if (!templateCollection)
          throw new Error("Template collection vanished");
        const [collection] = await tx
          .insert(collections)
          .values({
            userId: created.id,
            name: templateCollection.name,
            description: templateCollection.description,
          })
          .returning({ id: collections.id });
        if (!collection) throw new Error("Insert returned no collection");

        const idMap = new Map<string, string>(); // template document id -> copy's id
        const templateDocs = await tx
          .select()
          .from(documents)
          .where(eq(documents.collectionId, input.templateCollectionId));
        for (const doc of templateDocs) {
          const newId = randomUUID();
          idMap.set(doc.id, newId);
          let storagePath: string | null = null;
          if (doc.storagePath) {
            try {
              storagePath = await input.copyFile(
                doc.storagePath,
                created.id,
                newId,
                extname(doc.storagePath),
              );
              copiedPaths.push(storagePath);
            } catch {
              storagePath = null; // chat still works from the chunks; only "reprocess" needs the file
            }
          }
          await tx.insert(documents).values({
            id: newId,
            collectionId: collection.id,
            userId: created.id,
            sourceType: doc.sourceType,
            title: doc.title,
            originalFilename: doc.originalFilename,
            sourceUrl: doc.sourceUrl,
            mimeType: doc.mimeType,
            storagePath,
            sizeBytes: doc.sizeBytes,
            pageCount: doc.pageCount,
            status: "ready",
            chunkCount: doc.chunkCount,
            contentHash: doc.contentHash,
          });
          await tx.execute(sql`
            INSERT INTO chunks (document_id, collection_id, chunk_index, content, page_number, heading, token_count, embedding)
            SELECT ${newId}::uuid, ${collection.id}::uuid, chunk_index, content, page_number, heading, token_count, embedding
            FROM chunks WHERE document_id = ${doc.id}::uuid`);
        }

        const templateSets = await tx
          .select()
          .from(evalSets)
          .where(eq(evalSets.collectionId, input.templateCollectionId));
        for (const set of templateSets) {
          const [newSet] = await tx
            .insert(evalSets)
            .values({
              userId: created.id,
              collectionId: collection.id,
              name: set.name,
              description: set.description,
            })
            .returning({ id: evalSets.id });
          if (!newSet) throw new Error("Insert returned no eval set");
          const questions = await tx
            .select()
            .from(evalQuestions)
            .where(eq(evalQuestions.evalSetId, set.id));
          if (questions.length > 0) {
            await tx.insert(evalQuestions).values(
              questions.map((q) => ({
                evalSetId: newSet.id,
                question: q.question,
                expectedAnswer: q.expectedAnswer,
                expectedDocumentId: q.expectedDocumentId
                  ? (idMap.get(q.expectedDocumentId) ?? null)
                  : null,
              })),
            );
          }
        }
        return created;
      });
      return { user, copiedPaths };
    } catch (error) {
      (error as { copiedPaths?: string[] }).copiedPaths = copiedPaths;
      throw error;
    }
  }

  /** Deletes demo accounts older than `olderThan` (the rows cascade) and returns their ids so their files can go too. */
  async deleteExpired(olderThan: Date): Promise<string[]> {
    const rows = await this.db
      .delete(users)
      .where(and(eq(users.isDemo, true), lt(users.createdAt, olderThan)))
      .returning({ id: users.id });
    return rows.map((row) => row.id);
  }
}
