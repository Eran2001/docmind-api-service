import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { respond } from "../../common/http/api-response";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { EvalsService } from "./evals.service";
import {
  createEvalQuestionSchema,
  createEvalSetSchema,
  startEvalRunSchema,
  type CreateEvalQuestionInput,
  type CreateEvalSetInput,
  type StartEvalRunInput,
} from "./dto/evals.schemas";

@Controller("evals")
export class EvalsController {
  constructor(private readonly evals: EvalsService) {}

  @Get("sets")
  async listSets(@CurrentUser() user: AuthUser) {
    return respond.list(await this.evals.listSets(user.id));
  }

  @Post("sets")
  async createSet(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createEvalSetSchema)) body: CreateEvalSetInput,
  ) {
    const set = await this.evals.createSet(user.id, body);
    return respond.createdDone(set.resourceId, "Eval set created.");
  }

  @Get("sets/:resourceId")
  async getSet(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Eval set")) id: string,
  ) {
    return respond.ok(await this.evals.getSet(user.id, id));
  }

  @Delete("sets/:resourceId")
  async removeSet(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Eval set")) id: string,
  ) {
    await this.evals.removeSet(user.id, id);
    return respond.done("Eval set deleted.", id);
  }

  @Post("sets/:resourceId/questions")
  async addQuestion(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Eval set")) setId: string,
    @Body(new ZodValidationPipe(createEvalQuestionSchema))
    body: CreateEvalQuestionInput,
  ) {
    const question = await this.evals.addQuestion(user.id, setId, body);
    return respond.createdDone(question.resourceId, "Eval question created.");
  }

  @Delete("questions/:resourceId")
  async removeQuestion(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Eval question")) id: string,
  ) {
    await this.evals.removeQuestion(user.id, id);
    return respond.done("Eval question deleted.", id);
  }

  @Post("sets/:resourceId/runs")
  async startRun(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Eval set")) setId: string,
    @Body(new ZodValidationPipe(startEvalRunSchema)) body: StartEvalRunInput,
  ) {
    const run = await this.evals.startRun(user.id, setId, body);
    return respond.acceptedDone(run.resourceId, "Eval run queued.");
  }

  @Get("runs/:resourceId")
  async getRun(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Eval run")) id: string,
  ) {
    return respond.ok(await this.evals.getRun(user.id, id));
  }
}
