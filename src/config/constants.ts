export const API_PREFIX = "api/v1";

// Hybrid retrieval (spec 7.2). Kept here so evals can vary them.
export const RETRIEVAL = { RRF_K: 60, CANDIDATES: 30, TOP_K: 8 } as const;

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
