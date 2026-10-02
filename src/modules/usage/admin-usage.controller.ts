import { Controller, Get, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { RawResponse } from "../../common/decorators/raw-response.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { respond } from "../../common/http/api-response";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { usageQuerySchema, type UsageQuery } from "./dto/usage.schemas";
import { UsageService } from "./usage.service";

@Controller("admin")
export class AdminUsageController {
  constructor(private readonly usage: UsageService) {}

  /** `GET /admin/usage?days=30`: everyone's usage plus the 10 biggest spenders. Admins only; anyone else gets a 404. */
  @Get("usage")
  async usageForAll(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(usageQuerySchema)) query: UsageQuery,
  ) {
    if (user.role !== "admin") throw AppError.notFound("Page");
    return respond.ok(await this.usage.forAdmin(query.days));
  }

  /** `GET /admin/usage/export?days=30`: a CSV file with one row per model call by any user. Admins only. */
  @RawResponse()
  @Get("usage/export")
  async exportForAll(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(usageQuerySchema)) query: UsageQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (user.role !== "admin") throw AppError.notFound("Page");
    const csv = await this.usage.exportAdminCsv(query.days);
    void reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="admin-usage-${query.days}d.csv"`,
      )
      .header("Cache-Control", "no-store");
    return csv;
  }
}
