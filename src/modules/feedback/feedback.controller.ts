import { Controller, Get, Param, Query } from "@nestjs/common";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { respond } from "../../common/http/api-response";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { FeedbackService } from "./feedback.service";

const listQuerySchema = z.object({
  /** -1 = thumbs down (the default), 1 = thumbs up. */
  rating: z.coerce
    .number()
    .refine((value) => value === -1 || value === 1, "Use -1 or 1")
    .default(-1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
type ListQuery = z.infer<typeof listQuerySchema>;

@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /**
   * `GET /collections/:resourceId/feedback?rating=-1`: the answers you rated in this collection, with the question asked.
   * Down-voted answers are the best source of new eval questions.
   */
  @Get("collections/:resourceId/feedback")
  async list(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Collection")) collectionId: string,
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery,
  ) {
    return respond.list(
      await this.feedback.ratedAnswers(
        user.id,
        collectionId,
        query.rating as 1 | -1,
        query.limit,
      ),
    );
  }
}
