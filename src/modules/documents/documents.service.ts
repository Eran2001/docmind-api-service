import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { createHash, randomUUID } from "node:crypto";

import { AppError } from "../../common/errors/app-error";
import { InjectConfig } from "../../config/config.module";
import { QUEUES } from "../../config/constants";
import type { Env } from "../../config/env.schema";
import { StorageService } from "../../integrations/storage/storage.service";
import { CollectionsService } from "../collections/collections.service";
import type { AddUrlInput } from "./dto/documents.schemas";
import { DocumentsRepository, type DocumentRow } from "./documents.repository";
import { cleanFilename, detectFile } from "./file-type";

/** Spec 6.2: at most this many documents in one collection. */
export const MAX_DOCUMENTS_PER_COLLECTION = 50;

/** What the API sends for a document (dates as UTC ISO strings). */
export interface PublicDocument {
  resourceId: string;
  collectionId: string;
  sourceType: "file" | "url";
  title: string;
  originalFilename: string | null;
  sourceUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  status: "queued" | "processing" | "ready" | "failed";
  errorMessage: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

const toPublic = (row: DocumentRow): PublicDocument => ({
  resourceId: row.id,
  collectionId: row.collectionId,
  sourceType: row.sourceType === "url" ? "url" : "file",
  title: row.title,
  originalFilename: row.originalFilename,
  sourceUrl: row.sourceUrl,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  pageCount: row.pageCount,
  status: row.status as PublicDocument["status"],
  errorMessage: row.errorMessage,
  chunkCount: row.chunkCount,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const notFound = () => AppError.notFound("Document");
const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === "23505";
const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly collections: CollectionsService,
    private readonly storage: StorageService,
    @InjectQueue(QUEUES.INGEST) private readonly ingestQueue: Queue,
    @InjectConfig() private readonly config: Env,
  ) {}

  async list(userId: string, collectionId: string): Promise<PublicDocument[]> {
    await this.collections.requireOwned(userId, collectionId);
    return (await this.documents.list(userId, collectionId)).map(toPublic);
  }

  async getChunk(userId: string, documentId: string, chunkId: string) {
    const detail = await this.documents.findChunkDetail(
      userId,
      documentId,
      chunkId,
    );
    if (!detail) throw AppError.notFound("Chunk");
    return detail;
  }

  /** Stores the file, records it as `queued`, and queues the ingest job. Returns the new document id. */
  async uploadFile(
    userId: string,
    collectionId: string,
    upload: { filename: string; data: Buffer },
  ): Promise<string> {
    await this.collections.requireOwned(userId, collectionId);

    const filename = cleanFilename(upload.filename);
    const file = detectFile(upload.data, filename);
    if (!file) {
      const message =
        upload.data.length === 0
          ? "That file is empty."
          : "Unsupported file. Upload a PDF, DOCX, TXT or MD file.";
      throw AppError.validation(message, { fieldErrors: { file: [message] } });
    }

    const contentHash = sha256(upload.data);
    await this.assertCanAdd(collectionId, contentHash, filename);

    const id = randomUUID();
    const storagePath = await this.storage.save(
      userId,
      id,
      file.extension,
      upload.data,
    );
    try {
      await this.documents.create({
        id,
        collectionId,
        userId,
        sourceType: "file",
        title: filename,
        originalFilename: filename,
        mimeType: file.mimeType,
        storagePath,
        sizeBytes: upload.data.length,
        contentHash,
      });
    } catch (err) {
      await this.storage.remove(storagePath).catch(() => undefined);
      // Two identical uploads racing past the check: the unique (collection, hash) index decides.
      if (isUniqueViolation(err))
        throw AppError.duplicate(
          `“${filename}” is already in this collection.`,
        );
      throw err;
    }

    await this.enqueueOrUndo(id, async () => {
      await this.documents.delete(userId, id);
      await this.storage.remove(storagePath).catch(() => undefined);
    });
    return id;
  }

  /** Records a web page as `queued`. The AI service fetches it later (and is the one that blocks private addresses). */
  async addUrl(
    userId: string,
    collectionId: string,
    input: AddUrlInput,
  ): Promise<string> {
    await this.collections.requireOwned(userId, collectionId);

    const url = new URL(input.url);
    url.hash = "";
    const href = url.href;
    const title =
      `${url.host}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 200);
    const contentHash = sha256(`url:${href}`);
    await this.assertCanAdd(collectionId, contentHash, href);

    const id = randomUUID();
    try {
      await this.documents.create({
        id,
        collectionId,
        userId,
        sourceType: "url",
        title,
        sourceUrl: href,
        contentHash,
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.duplicate(`${href} is already in this collection.`);
      throw err;
    }
    await this.enqueueOrUndo(id, async () => {
      await this.documents.delete(userId, id);
    });
    return id;
  }

  /** Puts a document back at the start of the pipeline. A document that is already waiting or running is left alone. */
  async reprocess(userId: string, id: string): Promise<void> {
    const row = await this.documents.findOwned(userId, id);
    if (!row) throw notFound();
    if (row.status === "queued" || row.status === "processing") return;

    await this.documents.markQueued(id);
    await this.enqueueOrUndo(id, async () => {
      await this.documents.markFailed(
        id,
        "Couldn't queue this document for processing. Try again.",
      );
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const deleted = await this.documents.delete(userId, id);
    if (!deleted) throw notFound();
    await this.storage
      .remove(deleted.storagePath)
      .catch((err: unknown) =>
        this.logger.warn(`Couldn't delete a stored file: ${String(err)}`),
      );
  }

  private async assertCanAdd(
    collectionId: string,
    contentHash: string,
    label: string,
  ): Promise<void> {
    if (await this.documents.findByHash(collectionId, contentHash)) {
      throw AppError.duplicate(`“${label}” is already in this collection.`);
    }
    if (
      (await this.documents.countInCollection(collectionId)) >=
      MAX_DOCUMENTS_PER_COLLECTION
    ) {
      throw AppError.limit(
        `A collection can hold at most ${MAX_DOCUMENTS_PER_COLLECTION} documents.`,
      );
    }
  }

  /**
   * Queues the ingest job (`{ documentId }`). If Redis can't take it, undo what was just saved and say so, instead of leaving
   * a document that looks queued but never will be. (With Redis down BullMQ would wait forever, hence the timeout.)
   */
  private async enqueueOrUndo(
    documentId: string,
    undo: () => Promise<void>,
  ): Promise<void> {
    try {
      await withTimeout(
        this.ingestQueue.add(
          "ingest",
          { documentId },
          // A fresh job id every time (a reprocess must not collide with the first job); 1 try + 3 retries (spec 6.2).
          {
            jobId: `${documentId}-${Date.now()}`,
            attempts: 4,
            backoff: { type: "ingest" },
            removeOnComplete: 100,
            removeOnFail: 1000,
          },
        ),
        3000,
      );
    } catch (err) {
      this.logger.error(
        `Couldn't queue ingest for ${documentId}: ${String(err)}`,
      );
      await undo().catch((e: unknown) =>
        this.logger.error(`Undo after queue failure also failed: ${String(e)}`),
      );
      throw AppError.unavailable(
        "The processing queue is unavailable. Try again shortly.",
      );
    }
  }
}
