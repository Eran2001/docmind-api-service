import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT = "rateLimit";

export interface RateLimitOptions {
  /** Routes with the same name share one counter (login, register and refresh all count towards "auth"). */
  name: string;
  /** How many calls are allowed per window. */
  limit: number;
  windowSeconds: number;
  /** Count per signed-in user, or per client IP (for routes that have no user yet). */
  by: "user" | "ip";
}

/** Limits how often one user (or IP) can call a route; over the limit the API answers 429 `RateLimited` with `Retry-After`. */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT, options);
