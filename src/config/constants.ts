export const API_PREFIX = "api/v1";

// Hybrid retrieval (spec 7.2). Kept here so evals can vary them.
export const RETRIEVAL = {
  RRF_K: 60,
  CANDIDATES: 30,
  TOP_K: 8,
  /**
   * Cosine similarity (0..1) the best passage needs before the answer model is called at all. Measured with
   * text-embedding-3-small on real documents: unrelated text (a capital city, a joke, noise) scores 0.03 to 0.16 and genuine
   * questions 0.28 to 0.53, but small talk like "hello" can reach 0.29, so greetings are caught by rules (chat/intents.ts) and
   * this only filters text that is clearly unrelated. A keyword match in a passage always overrides it.
   */
  MIN_SIMILARITY: 0.15,
} as const;

export const COOKIES = { ACCESS: "dm_access", REFRESH: "dm_refresh" } as const;

export const QUEUES = { INGEST: "ingest-document", EVALS: "run-eval" } as const;

export const AUTH = {
  REFRESH_TTL_SECONDS: 7 * 24 * 60 * 60,
  /**
   * A rotated refresh token that shows up again within this window is a benign race (two tabs refreshing at once), so it is
   * rejected without signing the user out everywhere. After it, the same token means it was stolen and ALL sessions are revoked.
   */
  REFRESH_REUSE_GRACE_MS: 10_000,
  /** The refresh cookie is only sent to the auth routes. */
  REFRESH_COOKIE_PATH: `/${API_PREFIX}/auth`,
} as const;

/** The "Try the demo" sandbox (modules/demo): what a visitor may do, and how long the account lives. */
export const DEMO = {
  QUESTIONS: 5, // chat messages
  UPLOADS: 1, // files or web pages
  TTL_HOURS: 24,
  /** Demo accounts alive at once; past this, starting a new demo answers "busy". */
  MAX_ACTIVE: 200,
  /** The seeded account whose sample collection and eval set are copied for every visitor. */
  TEMPLATE_EMAIL: "demo@docmind.dev",
} as const;
