import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { TokensService } from "../../modules/auth/tokens.service";
import { IS_PUBLIC } from "../decorators/public.decorator";
import { AppError } from "../errors/app-error";

/** Global guard: every route needs a valid `Authorization: Bearer <access token>` unless it is `@Public()`. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const [scheme, token] = (req.headers.authorization ?? "").split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token)
      throw AppError.unauthorized();

    try {
      req.user = await this.tokens.verifyAccess(token);
    } catch {
      throw AppError.unauthorized("Session expired. Please sign in again.");
    }
    return true;
  }
}
