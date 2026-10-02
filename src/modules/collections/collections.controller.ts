import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";

import { NoDemo } from "../../common/decorators/no-demo.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { respond } from "../../common/http/api-response";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { CollectionsService } from "./collections.service";
import {
  createCollectionSchema,
  listCollectionsQuerySchema,
  updateCollectionSchema,
  type CreateCollectionInput,
  type ListCollectionsQuery,
  type UpdateCollectionInput,
} from "./dto/collections.schemas";

@Controller("collections")
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @NoDemo()
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createCollectionSchema))
    body: CreateCollectionInput,
  ) {
    const collection = await this.collections.create(user.id, body);
    return respond.createdDone(collection.resourceId, "Collection created.");
  }

  /** `GET /collections?search=handbook`: yours, newest activity first, each with its `documentCount`. */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodValidationPipe(listCollectionsQuerySchema))
    query: ListCollectionsQuery,
  ) {
    return respond.list(await this.collections.list(user.id, query.search));
  }

  /** One collection (the documents page header). Someone else's or a malformed id → 404. */
  @Get(":resourceId")
  async get(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Collection")) resourceId: string,
  ) {
    return respond.ok(await this.collections.requireOwned(user.id, resourceId));
  }

  @NoDemo()
  @Patch(":resourceId")
  async update(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Collection")) resourceId: string,
    @Body(new ZodValidationPipe(updateCollectionSchema))
    body: UpdateCollectionInput,
  ) {
    await this.collections.update(user.id, resourceId, body);
    return respond.done("Collection updated.", resourceId);
  }

  @NoDemo()
  @Delete(":resourceId")
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Collection")) resourceId: string,
  ) {
    await this.collections.remove(user.id, resourceId);
    return respond.done("Collection deleted.", resourceId);
  }
}
