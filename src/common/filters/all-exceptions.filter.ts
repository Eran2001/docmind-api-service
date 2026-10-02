import { ArgumentsHost, Catch, ExceptionFilter, Logger } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { InjectConfig } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import {
  toDebugInfo,
  toErrorEnvelope,
  toErrorResult,
} from "../errors/error-response";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(@InjectConfig() private readonly config: Env) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest>();
    const result = toErrorResult(exception);

    // Only unexpected failures are logged as errors; 4xx are the caller's problem.
    if (result.status >= 500) {
      this.logger.error(
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception),
      );
    }
    // `debug` (stack, original message) is for developers, so it never leaves a production server.
    const debug =
      this.config.NODE_ENV === "production"
        ? undefined
        : toDebugInfo(exception, req);
    void reply
      .status(result.status)
      .send(toErrorEnvelope(result, req.id, debug));
  }
}
