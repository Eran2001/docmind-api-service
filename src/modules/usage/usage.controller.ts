import { Controller, Get, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { RawResponse } from "../../common/decorators/raw-response.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { respond } from "../../common/http/api-response";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { usageQuerySchema, type UsageQuery } from "./dto/usage.schemas";
import { UsageService } from "./usage.service";

@Controller("usage")
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  /** `GET /usage/me?days=30`: your own cost, tokens and requests, per day and per kind. */
  @Get("me")
  async me(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(usageQuerySchema)) query: UsageQuery,
  ) {
    return respond.ok(await this.usage.forUser(user.id, query.days));
  }

  /** `GET /usage/me/export?days=30`: a CSV file with one row per model call (not the JSON envelope). */
  @RawResponse()
  @Get("me/export")
  async export(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(usageQuerySchema)) query: UsageQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const csv = await this.usage.exportCsv(user.id, query.days);
    void reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="usage-${query.days}d.csv"`,
      )
      .header("Cache-Control", "no-store");
    return csv;
  }
}
