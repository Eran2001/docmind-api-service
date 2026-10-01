import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiClient,
  AiServiceError,
  type IngestResponse,
} from "../../integrations/ai/ai.client";
import { StorageService } from "../../integrations/storage/storage.service";
import {
  DocumentsRepository,
  type DocumentRow,
} from "../../modules/documents/documents.repository";
import {
  INGEST_RETRY_DELAYS_MS,
  IngestProcessor,
  ingestBackoffStrategy,
  type IngestJob,
} from "./ingest.processor";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

import { readFile } from "node:fs/promises";

const documentId = "00000000-0000-4000-8000-000000000001";
const collectionId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";

const urlDocument = {
  id: documentId,
  collectionId,
  userId,
  sourceType: "url",
  sourceUrl: "https://example.com/handbook",
  storagePath: null,
  mimeType: null,
  originalFilename: null,
  title: "example.com/handbook",
} as DocumentRow;

const fileDocument = {
  ...urlDocument,
  sourceType: "file",
  sourceUrl: null,
  storagePath: "user/document.txt",
  mimeType: "text/plain",
  originalFilename: "document.txt",
} as DocumentRow;

const ingestResponse: IngestResponse = {
  title: null,
  page_count: null,
  chunks: [
    {
      index: 0,
      content: "Example source text with enough detail.",
      page_number: null,
      heading: null,
      token_count: 8,
      embedding: Array.from({ length: 1536 }, () => 0.25),
    },
  ],
  usage: {
    model: "text-embedding-3-small",
    input_tokens: 8,
    output_tokens: 0,
    latency_ms: 12,
  },
};

describe("IngestProcessor", () => {
  it("uses the configured retry schedule", () => {
    expect(
      INGEST_RETRY_DELAYS_MS.map((_, index) =>
        ingestBackoffStrategy(index + 1, "ingest"),
      ),
    ).toEqual([5_000, 25_000, 125_000]);
    expect(ingestBackoffStrategy(1, "other")).toBe(-1);
  });

  let repository: {
    findById: ReturnType<typeof vi.fn>;
    markProcessing: ReturnType<typeof vi.fn>;
    saveIngestResult: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
  let storage: { absolutePath: ReturnType<typeof vi.fn> };
  let ai: {
    ingestFile: ReturnType<typeof vi.fn>;
    ingestUrl: ReturnType<typeof vi.fn>;
  };
  let processor: IngestProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    repository = {
      findById: vi.fn().mockResolvedValue(urlDocument),
      markProcessing: vi.fn().mockResolvedValue(true),
      saveIngestResult: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    storage = {
      absolutePath: vi.fn().mockReturnValue("/storage/user/document.txt"),
    };
    ai = {
      ingestFile: vi.fn().mockResolvedValue(ingestResponse),
      ingestUrl: vi.fn().mockResolvedValue(ingestResponse),
    };
    processor = new IngestProcessor(
      repository as unknown as DocumentsRepository,
      storage as unknown as StorageService,
      ai as unknown as AiClient,
    );
  });

  it("ingests a URL and atomically hands chunks and usage to the repository", async () => {
    await processor.process(job());

    expect(repository.markProcessing).toHaveBeenCalledWith(documentId);
    expect(ai.ingestUrl).toHaveBeenCalledWith(urlDocument.sourceUrl);
    expect(repository.saveIngestResult).toHaveBeenCalledWith(
      documentId,
      collectionId,
      userId,
      null,
      ingestResponse.chunks,
      ingestResponse.usage,
    );
    expect(ai.ingestFile).not.toHaveBeenCalled();
  });

  it("reads stored file bytes and sends them to the AI service", async () => {
    repository.findById.mockResolvedValue(fileDocument);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("stored text"));

    await processor.process(job());

    expect(storage.absolutePath).toHaveBeenCalledWith(fileDocument.storagePath);
    expect(ai.ingestFile).toHaveBeenCalledWith(
      Buffer.from("stored text"),
      "text/plain",
      "document.txt",
    );
    expect(ai.ingestUrl).not.toHaveBeenCalled();
  });

  it("does nothing when the document was deleted before the job starts", async () => {
    repository.findById.mockResolvedValue(undefined);

    await processor.process(job());

    expect(repository.markProcessing).not.toHaveBeenCalled();
    expect(ai.ingestUrl).not.toHaveBeenCalled();
  });

  it("does nothing when the document disappears before processing starts", async () => {
    repository.markProcessing.mockResolvedValue(false);

    await processor.process(job());

    expect(ai.ingestUrl).not.toHaveBeenCalled();
    expect(repository.saveIngestResult).not.toHaveBeenCalled();
  });

  it("keeps retryable failures processing until BullMQ exhausts attempts", async () => {
    const failedJob = job(1);
    const error = new AiServiceError("URL_FETCH_FAILED", "fetch failed");
    ai.ingestUrl.mockRejectedValue(error);

    await expect(processor.process(failedJob)).rejects.toBe(error);
    await processor.onFailed(failedJob, error);

    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("marks a document failed with a safe message after the final attempt", async () => {
    const failedJob = job(4);
    const error = new AiServiceError(
      "URL_BLOCKED",
      "internal address rejected",
    );

    await processor.onFailed(failedJob, error);

    expect(repository.markFailed).toHaveBeenCalledWith(
      documentId,
      "That web address isn't allowed.",
    );
  });

  it("does not expose unknown failure details to the user", async () => {
    const failedJob = job(4);

    await processor.onFailed(failedJob, new Error("secret or internal detail"));

    expect(repository.markFailed).toHaveBeenCalledWith(
      documentId,
      "Document processing failed. Try again shortly.",
    );
  });
});

function job(attemptsMade = 0): Job<IngestJob> {
  return {
    name: "ingest",
    data: { documentId },
    opts: { attempts: 4 },
    attemptsMade,
  } as Job<IngestJob>;
}
