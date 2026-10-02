import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { AppError } from "../errors/app-error";
import type { AuthUser } from "../types/fastify";

/** `@CurrentUser() user: AuthUser` in a protected route. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<FastifyRequest>().user;
    if (!user) throw AppError.unauthorized();
    return user;
  },
);
