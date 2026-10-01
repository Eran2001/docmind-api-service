import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { readFile } from "node:fs/promises";

import { QUEUES } from "../../config/constants";
import { AiClient, AiServiceError } from "../../integrations/ai/ai.client";
import { StorageService } from "../../integrations/storage/storage.service";
import { DocumentsRepository } from "../../modules/documents/documents.repository";
import type { DocumentRow } from "../../modules/documents/documents.repository";
import type { IngestResponse } from "../../integrations/ai/ai.client";

export interface IngestJob {
  documentId: string;
}

export const INGEST_RETRY_DELAYS_MS = [5_000, 25_000, 125_000] as const;

export function ingestBackoffStrategy(
  attemptsMade: number,
  type?: string,
): number {
  if (type !== "ingest") return -1;
  return INGEST_RETRY_DELAYS_MS[attemptsMade - 1] ?? -1;
}

const FAILURE_MESSAGES: Record<string, string> = {
  PARSE_FAILED:
    "We couldn't read this document. Try a text-based PDF, DOCX, TXT or MD file.",
  EMPTY_DOCUMENT:
    "We couldn't find enough readable text in this document to index it.",
  URL_FETCH_FAILED:
    "We couldn't load that web page. Check the URL and try again.",
  URL_BLOCKED: "That web address isn't allowed.",
  LLM_ERROR:
    "Document processing is temporarily unavailable. Try again shortly.",
  AI_UNAVAILABLE:
    "Document processing is temporarily unavailable. Try again shortly.",
  AI_INVALID_RESPONSE:
    "Document processing failed unexpectedly. Try again shortly.",
};

@Processor(QUEUES.INGEST, {
  settings: { backoffStrategy: ingestBackoffStrategy },
})
@Injectable()
export class IngestProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestProcessor.name);

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly storage: StorageService,
    private readonly ai: AiClient,
  ) {
    super();
  }

  async process(job: Job<IngestJob>): Promise<void> {
    if (job.name !== "ingest")
      throw new Error(`Unsupported ingest job: ${job.name}`);

    const { documentId } = job.data;
    const document = await this.documents.findById(documentId);
    if (!document || !(await this.documents.markProcessing(documentId))) return;

    const result = await this.processDocument(document);
    await this.documents.saveIngestResult(
      documentId,
      document.collectionId,
      document.userId,
      result.page_count,
      result.chunks,
      result.usage,
    );
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<IngestJob> | undefined, error: Error): Promise<void> {
    if (
      !job ||
      job.name !== "ingest" ||
      job.attemptsMade < (job.opts.attempts ?? 1)
    )
      return;
    const message =
      error instanceof AiServiceError
        ? (FAILURE_MESSAGES[error.code] ??
          "Document processing failed. Try again shortly.")
        : "Document processing failed. Try again shortly.";
    try {
      await this.documents.markFailed(job.data.documentId, message);
    } catch (markError) {
      this.logger.error(
        `Could not mark document ${job.data.documentId} failed: ${markError instanceof Error ? markError.name : "unknown error"}`,
      );
    }
  }

  private async processDocument(
    document: DocumentRow,
  ): Promise<IngestResponse> {
    if (document.sourceType === "url") {
      if (!document.sourceUrl)
        throw new Error("URL document has no source URL");
      return this.ai.ingestUrl(document.sourceUrl);
    }
    if (!document.storagePath || !document.mimeType)
      throw new Error("File document is missing its stored file metadata");
    const bytes = await readFile(
      this.storage.absolutePath(document.storagePath),
    );
    return this.ai.ingestFile(
      bytes,
      document.mimeType,
      document.originalFilename ?? document.title,
    );
  }
}
