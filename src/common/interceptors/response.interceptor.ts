import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { map, type Observable } from "rxjs";

import { RAW_RESPONSE } from "../decorators/raw-response.decorator";
import { ApiResponse, respond, toEnvelope } from "../http/api-response";

/** Wraps every controller result in the success envelope and adds the request id. */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [context.getHandler(), context.getClass()]);
    if (raw) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    return next.handle().pipe(
      map((value: unknown) => {
        // Nothing to wrap: 204 responses, or a handler that already wrote the response itself.
        if (value === undefined || reply.sent) return value;
        const res = value instanceof ApiResponse ? value : respond.ok(value);
        if (res.status) void reply.status(res.status);
        return toEnvelope(res, req.id);
      }),
    );
  }
}
