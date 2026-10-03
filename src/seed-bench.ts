// A larger benchmark for tuning retrieval: four long, real documents (the DocMind spec and the three READMEs, frozen
// copies in bench/corpus) and 40 questions about facts buried in them. Unlike the Northwind samples, these documents split
// into dozens of chunks, so "was the right passage retrieved?" is a real question. Added by `npm run db:seed:bench`
// (to the demo account, in its own collection, so the public demo copy does not include it).

export const BENCH_COLLECTION = {
  name: "DocMind Docs (benchmark)",
  description:
    "The DocMind spec and READMEs, for tuning retrieval with an eval set.",
} as const;

export type BenchDocKey = "spec" | "api" | "web" | "ai";

export const BENCH_FILES: Record<BenchDocKey, string> = {
  spec: "docmind-spec.md",
  api: "docmind-api-readme.md",
  web: "docmind-web-readme.md",
  ai: "docmind-ai-readme.md",
};

export const BENCH_SET = {
  name: "DocMind docs benchmark",
  description:
    "40 questions about facts buried in four long documents. Retrieval hit means the passage containing the evidence was retrieved.",
} as const;

export const NOT_IN_DOCS =
  "I couldn't find that in your documents. The answer is not in them.";

export type BenchKind =
  "needle" | "paraphrase" | "readme" | "exact" | "unanswerable";

export interface BenchQuestion {
  kind: BenchKind;
  question: string;
  expected: string;
  doc?: BenchDocKey;
  /** A phrase from the document that the answer rests on. A retrieved passage must contain it to count as a hit. */
  evidence?: string;
}

export const BENCH_QUESTIONS: BenchQuestion[] = [
  // --- needles: one specific fact deep inside a long document (12)
  {
    kind: "needle",
    doc: "spec",
    question: "How long is the access token valid?",
    expected: "15 minutes (an HS256 JWT).",
    evidence: "access JWT (HS256, 15 min",
  },
  {
    kind: "needle",
    doc: "spec",
    question:
      "According to the original spec, which path is the refresh cookie limited to?",
    expected: "/auth",
    evidence: "refresh cookie `path=/auth`",
  },
  {
    kind: "needle",
    doc: "spec",
    question: "What size and count limits apply to uploads?",
    expected: "20 MB per file and 50 documents per collection.",
    evidence: "max 20 MB, max 50 documents per collection",
  },
  {
    kind: "needle",
    doc: "spec",
    question:
      "What status is returned when the same file is uploaded twice to a collection?",
    expected: "409 with the code DUPLICATE_DOCUMENT.",
    evidence: "409 `DUPLICATE_DOCUMENT`",
  },
  {
    kind: "needle",
    doc: "spec",
    question: "What is the retry backoff schedule for failed ingestion jobs?",
    expected: "3 retries with exponential backoff of 5s, 25s and 125s.",
    evidence: "exponential backoff (5s, 25s, 125s)",
  },
  {
    kind: "needle",
    doc: "spec",
    question: "What timeout and size limit apply when fetching a URL?",
    expected: "A 15 second timeout and a 5 MB maximum.",
    evidence: "15s timeout, max 5 MB",
  },
  {
    kind: "needle",
    doc: "spec",
    question:
      "How many earlier messages are used to rewrite a follow-up question?",
    expected: "The last 6 messages.",
    evidence: "last 6 messages + new question",
  },
  {
    kind: "needle",
    doc: "spec",
    question: "How many chunks does hybrid retrieval return?",
    expected: "The top 8 chunks.",
    evidence: "→ top 8 chunks",
  },
  {
    kind: "needle",
    doc: "spec",
    question: "How many tokens do consecutive chunks overlap?",
    expected: "80 tokens.",
    evidence: "**80 tokens overlap**",
  },
  {
    kind: "needle",
    doc: "spec",
    question: "Chunks with fewer than how many tokens are dropped?",
    expected: "20 tokens.",
    evidence: "fewer than 20 tokens",
  },
  {
    kind: "needle",
    doc: "spec",
    question:
      "How many characters of the chunk does a citation snippet contain?",
    expected: "The first 240 characters.",
    evidence: "first 240 chars of chunk",
  },
  {
    kind: "needle",
    doc: "spec",
    question: "What max_tokens and temperature does the answering model use?",
    expected: "1024 max tokens and temperature 0.2.",
    evidence: "| 1024 | 0.2 |",
  },

  // --- paraphrases: the question avoids the document's wording (8)
  {
    kind: "paraphrase",
    doc: "spec",
    question:
      "How often does the web app check whether a document has finished processing?",
    expected: "Every 3 seconds, while any document is queued or processing.",
    evidence: "every 3s",
  },
  {
    kind: "paraphrase",
    doc: "spec",
    question:
      "What happens if someone presents a refresh token that was already used?",
    expected:
      "All of that user's refresh tokens are revoked (theft detection).",
    evidence: "revoke ALL user's refresh tokens",
  },
  {
    kind: "paraphrase",
    doc: "spec",
    question: "What does the app say when none of the documents are relevant?",
    expected: '"I couldn\'t find anything in your documents about that."',
    evidence: "I couldn't find anything in your documents about that.",
  },
  {
    kind: "paraphrase",
    doc: "spec",
    question: "How are passwords and cookies kept out of the logs?",
    expected: "pino redaction of password, authorization and cookie.",
    evidence: "pino redaction for `password`, `authorization`, `cookie`",
  },
  {
    kind: "paraphrase",
    doc: "spec",
    question: "Which hashing scheme protects user passwords?",
    expected: "argon2id.",
    evidence: "argon2id password hashing",
  },
  {
    kind: "paraphrase",
    doc: "spec",
    question: "How is a new conversation given its title?",
    expected:
      "A background call to the fast model writes a title of at most 6 words.",
    evidence: "max 6 words",
  },
  {
    kind: "paraphrase",
    doc: "spec",
    question:
      "What happens to a half-streamed answer when the browser disconnects?",
    expected:
      "The request is aborted, the message is marked as an error, and the partial content is saved.",
    evidence: "save partial content",
  },
  {
    kind: "paraphrase",
    doc: "spec",
    question:
      "Which kind of scanned-document support is deliberately left out?",
    expected: "OCR for scanned PDFs.",
    evidence: "OCR for scanned PDFs",
  },

  // --- facts in the READMEs, which are long and full of similar-looking numbers (10)
  {
    kind: "readme",
    doc: "api",
    question: "How many demo accounts can exist at the same time?",
    expected: "At most 200.",
    evidence: "At most 200 exist at once",
  },
  {
    kind: "readme",
    doc: "api",
    question: "How long does a demo account live before it is deleted?",
    expected: "24 hours.",
    evidence: "24 hours after they were created",
  },
  {
    kind: "readme",
    doc: "api",
    question: "How many demo sandboxes can one IP address start per hour?",
    expected: "5 per hour.",
    evidence: "5 per hour per IP",
  },
  {
    kind: "readme",
    doc: "api",
    question: "What is the maximum number of rows in the usage CSV export?",
    expected: "100,000 rows.",
    evidence: "Capped at 100,000 rows",
  },
  {
    kind: "readme",
    doc: "api",
    question: "Below what similarity is the answer model skipped entirely?",
    expected: "0.15 (RETRIEVAL.MIN_SIMILARITY).",
    evidence: "MIN_SIMILARITY` (0.15",
  },
  {
    kind: "readme",
    doc: "api",
    question: "Which picture formats are accepted for an avatar?",
    expected: "PNG, JPEG or WebP, up to 2 MB.",
    evidence: "PNG, JPEG or WebP",
  },
  {
    kind: "readme",
    doc: "web",
    question:
      "Which version of Next.js does the web README say the app is built with?",
    expected: "Next.js 16 (App Router).",
    evidence: "Next.js 16 (App Router)",
  },
  {
    kind: "readme",
    doc: "ai",
    question: "Which library converts old .doc files?",
    expected: "LibreOffice.",
    evidence: "LibreOffice",
  },
  {
    kind: "readme",
    doc: "ai",
    question: "Which library pulls the text out of web pages?",
    expected: "trafilatura.",
    evidence: "trafilatura",
  },
  {
    kind: "readme",
    doc: "ai",
    question: "Which setting chooses a separate model for grading evals?",
    expected: "LLM_JUDGE_MODEL.",
    evidence: "LLM_JUDGE_MODEL",
  },

  // --- exact strings and numbers (4)
  {
    kind: "exact",
    doc: "spec",
    question: "Where on disk are uploaded files stored?",
    expected: "STORAGE_DIR/{userId}/{documentId}{ext}.",
    evidence: "STORAGE_DIR/{userId}/{documentId}{ext}",
  },
  {
    kind: "exact",
    doc: "spec",
    question:
      "How many chunks are inserted per batch when saving a processed document?",
    expected: "Batches of 200.",
    evidence: "batches of 200",
  },
  {
    kind: "exact",
    doc: "spec",
    question: "In what batch size are chunks sent for embedding?",
    expected: "Batches of 100.",
    evidence: "batches of 100",
  },
  {
    kind: "exact",
    doc: "spec",
    question: "What are the chat, upload and auth rate limits?",
    expected:
      "Chat 20 per minute per user, uploads 30 per hour per user, auth routes 10 per minute per IP.",
    evidence: "Chat messages: 20 per minute per user",
  },

  // --- not in the documents (6)
  {
    kind: "unanswerable",
    question: "Who is the CEO of DocMind?",
    expected: NOT_IN_DOCS,
  },
  {
    kind: "unanswerable",
    question: "How many people are on the DocMind team?",
    expected: NOT_IN_DOCS,
  },
  {
    kind: "unanswerable",
    question: "Which error-tracking service does DocMind use in production?",
    expected: NOT_IN_DOCS,
  },
  {
    kind: "unanswerable",
    question: "What uptime does DocMind guarantee?",
    expected: NOT_IN_DOCS,
  },
  {
    kind: "unanswerable",
    question: "Which Kubernetes version does DocMind run on?",
    expected: NOT_IN_DOCS,
  },
  {
    kind: "unanswerable",
    question: "Can I export a conversation to PDF?",
    expected: NOT_IN_DOCS,
  },
];
