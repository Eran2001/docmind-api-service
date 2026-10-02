import { Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { respond } from "../../common/http/api-response";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { ConversationsService } from "./conversations.service";
import {
  listConversationsQuerySchema,
  type ListConversationsQuery,
} from "./dto/conversations.schemas";

@Controller()
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post("collections/:resourceId/conversations")
  async create(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Collection")) collectionId: string,
  ) {
    const conversation = await this.conversations.create(user.id, collectionId);
    return respond.createdDone(
      conversation.resourceId,
      "Conversation created.",
    );
  }

  @Get("collections/:resourceId/conversations")
  async list(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Collection")) collectionId: string,
    @Query(new ZodValidationPipe(listConversationsQuerySchema))
    query: ListConversationsQuery,
  ) {
    const { items, nextCursor } = await this.conversations.list(
      user.id,
      collectionId,
      query,
    );
    return respond.list(items, { nextCursor });
  }

  @Get("conversations/:resourceId")
  async get(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Conversation")) id: string,
  ) {
    return respond.ok(await this.conversations.get(user.id, id));
  }

  @Delete("conversations/:resourceId")
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Conversation")) id: string,
  ) {
    await this.conversations.remove(user.id, id);
    return respond.done("Conversation deleted.", id);
  }
}
