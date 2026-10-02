import "@fastify/multipart";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { respond } from "../../common/http/api-response";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { InjectConfig } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import { addUrlSchema, type AddUrlInput } from "./dto/documents.schemas";
import { DemoLimitsService } from "../demo/demo-limits.service";
import { DocumentsService } from "./documents.service";

/** Spec 8.4: 30 uploads (files and URLs together) per hour per user. */
const UPLOAD_LIMIT = {
  name: "upload",
  limit: 30,
  windowSeconds: 3600,
  by: "user",
} as const;

const collectionId = () => new UuidParamPipe("Collection");
const documentId = () => new UuidParamPipe("Document");

const fileError = (message: string) =>
  AppError.validation(message, { fieldErrors: { file: [message] } });

@Controller()
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly demoLimits: DemoLimitsService,
    @InjectConfig() private readonly config: Env,
  ) {}

  @Get("collections/:resourceId/documents")
  async list(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", collectionId()) collectionResourceId: string,
  ) {
    return respond.list(
      await this.documents.list(user.id, collectionResourceId),
    );
  }

  @Get("documents/:resourceId/chunks/:chunkId")
  async getChunk(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", documentId()) resourceId: string,
    @Param("chunkId", new UuidParamPipe("Chunk")) chunkId: string,
  ) {
    return respond.ok(
      await this.documents.getChunk(user.id, resourceId, chunkId),
    );
  }

  /** multipart/form-data with one `file` field. 202: the file is saved and queued; processing happens in the background. */
  @RateLimit(UPLOAD_LIMIT)
  @Post("collections/:resourceId/documents")
  async upload(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", collectionId()) collectionResourceId: string,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw fileError(
        'Send the file as multipart/form-data in a field named "file".',
      );

    const part = await req.file();
    if (!part || part.fieldname !== "file")
      throw fileError('Send the file in a field named "file".');

    let data: Buffer;
    try {
      data = await part.toBuffer(); // throws when the file is over the size limit
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
        throw fileError(
          `That file is larger than ${this.config.MAX_UPLOAD_MB} MB.`,
        );
      throw err;
    }
    if (part.file.truncated)
      throw fileError(
        `That file is larger than ${this.config.MAX_UPLOAD_MB} MB.`,
      );

    // Demo visitors get one upload; the unit is handed back if the file turns out to be unusable.
    if (user.demo) await this.demoLimits.reserveUpload(user.id);
    let newId: string;
    try {
      newId = await this.documents.uploadFile(user.id, collectionResourceId, {
        filename: part.filename,
        data,
      });
    } catch (error) {
      if (user.demo) await this.demoLimits.refund(user.id, "upload");
      throw error;
    }
    return respond.acceptedDone(newId, "Document queued for processing.");
  }

  @RateLimit(UPLOAD_LIMIT)
  @Post("collections/:resourceId/documents/url")
  async addUrl(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", collectionId()) collectionResourceId: string,
    @Body(new ZodValidationPipe(addUrlSchema)) body: AddUrlInput,
  ) {
    if (user.demo) await this.demoLimits.reserveUpload(user.id);
    let newId: string;
    try {
      newId = await this.documents.addUrl(user.id, collectionResourceId, body);
    } catch (error) {
      if (user.demo) await this.demoLimits.refund(user.id, "upload");
      throw error;
    }
    return respond.acceptedDone(newId, "URL queued for processing.");
  }

  @Post("documents/:resourceId/reprocess")
  async reprocess(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", documentId()) resourceId: string,
  ) {
    await this.documents.reprocess(user.id, resourceId);
    return respond.acceptedDone(resourceId, "Document queued for processing.");
  }

  @Delete("documents/:resourceId")
  async remove(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", documentId()) resourceId: string,
  ) {
    await this.documents.remove(user.id, resourceId);
    return respond.done("Document deleted.", resourceId);
  }
}
