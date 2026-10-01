// Drizzle schema for every table in spec Section 5. Migrations are generated from this file (npm run db:generate).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default("user"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("users_role_check", sql`${t.role} IN ('user', 'admin')`)],
);

export const refreshTokens = pgTable("refresh_tokens", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // sha256 of the token, never the raw token
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const collections = pgTable(
  "collections",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("collections_user_id_idx").on(t.userId)],
);

export const documents = pgTable(
  "documents",
  {
    id: id(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    title: text("title").notNull(),
    originalFilename: text("original_filename"),
    sourceUrl: text("source_url"),
    mimeType: text("mime_type"),
    storagePath: text("storage_path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    pageCount: integer("page_count"),
    status: text("status").notNull().default("queued"),
    errorMessage: text("error_message"),
    chunkCount: integer("chunk_count").notNull().default(0),
    contentHash: text("content_hash"), // sha256 of the bytes, used to dedupe within a collection
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("documents_collection_id_idx").on(t.collectionId),
    unique("documents_collection_hash_unique").on(
      t.collectionId,
      t.contentHash,
    ),
    check(
      "documents_source_type_check",
      sql`${t.sourceType} IN ('file', 'url')`,
    ),
    check(
      "documents_status_check",
      sql`${t.status} IN ('queued', 'processing', 'ready', 'failed')`,
    ),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: id(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    pageNumber: integer("page_number"), // null for URLs and plain text
    heading: text("heading"),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('english', content)`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    index("chunks_collection_id_idx").on(t.collectionId),
    index("chunks_embedding_hnsw").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("chunks_tsv_gin").using("gin", t.tsv),
  ],
);

export const conversations = pgTable("conversations", {
  id: id(),
  collectionId: uuid("collection_id")
    .notNull()
    .references(() => collections.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("New chat"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations").notNull().default([]), // shape: spec 7.3
    status: text("status").notNull().default("complete"),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    check("messages_role_check", sql`${t.role} IN ('user', 'assistant')`),
    check(
      "messages_status_check",
      sql`${t.status} IN ('streaming', 'complete', 'error')`,
    ),
  ],
);

export const messageFeedback = pgTable(
  "message_feedback",
  {
    id: id(),
    messageId: uuid("message_id")
      .notNull()
      .unique()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: smallint("rating").notNull(),
    comment: text("comment"),
    createdAt: createdAt(),
  },
  (t) => [check("message_feedback_rating_check", sql`${t.rating} IN (-1, 1)`)],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms"),
    refType: text("ref_type"), // 'message' | 'document' | 'eval_run'
    refId: uuid("ref_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_events_user_created_idx").on(t.userId, t.createdAt),
    check(
      "usage_events_kind_check",
      sql`${t.kind} IN ('embed', 'answer', 'rewrite', 'judge')`,
    ),
  ],
);

export const evalSets = pgTable("eval_sets", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  collectionId: uuid("collection_id")
    .notNull()
    .references(() => collections.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: createdAt(),
});

export const evalQuestions = pgTable("eval_questions", {
  id: id(),
  evalSetId: uuid("eval_set_id")
    .notNull()
    .references(() => evalSets.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  expectedAnswer: text("expected_answer").notNull(),
  expectedDocumentId: uuid("expected_document_id").references(
    () => documents.id,
    { onDelete: "set null" },
  ),
  createdAt: createdAt(),
});

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: id(),
    evalSetId: uuid("eval_set_id")
      .notNull()
      .references(() => evalSets.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    avgCorrectness: numeric("avg_correctness", { precision: 4, scale: 3 }),
    avgFaithfulness: numeric("avg_faithfulness", { precision: 4, scale: 3 }),
    retrievalHitRate: numeric("retrieval_hit_rate", { precision: 4, scale: 3 }),
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 }),
    config: jsonb("config").notNull(), // retrieval settings used (topK, ...)
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "eval_runs_status_check",
      sql`${t.status} IN ('queued', 'running', 'done', 'failed')`,
    ),
  ],
);

export const evalResults = pgTable("eval_results", {
  id: id(),
  evalRunId: uuid("eval_run_id")
    .notNull()
    .references(() => evalRuns.id, { onDelete: "cascade" }),
  evalQuestionId: uuid("eval_question_id")
    .notNull()
    .references(() => evalQuestions.id, { onDelete: "cascade" }),
  generatedAnswer: text("generated_answer").notNull(),
  retrievedChunkIds: uuid("retrieved_chunk_ids").array().notNull(),
  correctness: numeric("correctness", { precision: 4, scale: 3 }).notNull(),
  faithfulness: numeric("faithfulness", { precision: 4, scale: 3 }).notNull(),
  retrievalHit: boolean("retrieval_hit").notNull(),
  judgeReasoning: text("judge_reasoning"),
  createdAt: createdAt(),
});
