import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { NO_DEMO } from "../decorators/no-demo.decorator";
import { AppError } from "../errors/app-error";

/** Runs after JwtAuthGuard, so `req.user.demo` is known. Only routes marked `@NoDemo()` are affected. */
@Injectable()
export class DemoRestrictionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const blocked = this.reflector.getAllAndOverride<boolean | undefined>(
      NO_DEMO,
      [context.getHandler(), context.getClass()],
    );
    if (!blocked) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (req.user?.demo) throw AppError.demoRestricted();
    return true;
  }
}
