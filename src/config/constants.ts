export const API_PREFIX = "api/v1";

// Hybrid retrieval (spec 7.2). Kept here so evals can vary them.
export const RETRIEVAL = { RRF_K: 60, CANDIDATES: 30, TOP_K: 8 } as const;

export const COOKIES = { ACCESS: "dm_access", REFRESH: "dm_refresh" } as const;

export const QUEUES = { INGEST: "ingest-document", EVALS: "run-eval" } as const;

export const AUTH = {
  ACCESS_TTL_SECONDS: 15 * 60,
  REFRESH_TTL_SECONDS: 7 * 24 * 60 * 60,
  /** The refresh cookie is only sent to the auth routes. */
  REFRESH_COOKIE_PATH: `/${API_PREFIX}/auth`,
} as const;
