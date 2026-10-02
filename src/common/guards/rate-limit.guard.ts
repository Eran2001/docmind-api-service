import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

import { REDIS } from "../../integrations/redis/redis.module";
import {
  RATE_LIMIT,
  type RateLimitOptions,
} from "../decorators/rate-limit.decorator";
import { AppError } from "../errors/app-error";
import { describeError, throttle } from "../utils/describe-error";

/**
 * Fixed-window counter in Redis: `rl:<name>:<user id or ip>`, one INCR per call, expiring when the window ends.
 * Runs after JwtAuthGuard (so `req.user` is set). If Redis is down it lets the request through and logs a warning:
 * a broken limiter should not take the whole API with it.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly warn = throttle((message) => this.logger.warn(message));

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<
      RateLimitOptions | undefined
    >(RATE_LIMIT, [context.getHandler(), context.getClass()]);
    if (!options) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const subject = options.by === "user" ? (req.user?.id ?? req.ip) : req.ip;
    const key = `rl:${options.name}:${subject}`;

    let count: number;
    let ttlMs: number;
    try {
      const results = await this.redis
        .multi()
        .incr(key)
        .pexpire(key, options.windowSeconds * 1000, "NX")
        .pttl(key)
        .exec();
      count = Number(results?.[0]?.[1]);
      ttlMs = Number(results?.[2]?.[1]);
      if (!Number.isFinite(count)) return true;
    } catch (error) {
      this.warn(`Rate limiter skipped (Redis): ${describeError(error)}`);
      return true;
    }

    if (count > options.limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((ttlMs > 0 ? ttlMs : options.windowSeconds * 1000) / 1000),
      );
      void http
        .getResponse<FastifyReply>()
        .header("Retry-After", String(retryAfter));
      throw AppError.rateLimited(
        `Too many requests. Try again in ${retryAfter} seconds.`,
      );
    }
    return true;
  }
}
