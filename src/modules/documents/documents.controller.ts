import "@fastify/multipart";
import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { respond } from "../../common/http/api-response";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { InjectConfig } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import { addUrlSchema, type AddUrlInput } from "./dto/documents.schemas";
import { DocumentsService } from "./documents.service";

const collectionId = () => new UuidParamPipe("Collection");
const documentId = () => new UuidParamPipe("Document");

const fileError = (message: string) => AppError.validation(message, { fieldErrors: { file: [message] } });

@Controller()
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    @InjectConfig() private readonly config: Env,
  ) {}

  @Get("collections/:resourceId/documents")
  async list(@CurrentUser() user: AuthUser, @Param("resourceId", collectionId()) collectionResourceId: string) {
    return respond.list(await this.documents.list(user.id, collectionResourceId));
  }

  /** multipart/form-data with one `file` field. 202: the file is saved and queued; processing happens in the background. */
  @Post("collections/:resourceId/documents")
  async upload(@CurrentUser() user: AuthUser, @Param("resourceId", collectionId()) collectionResourceId: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) throw fileError('Send the file as multipart/form-data in a field named "file".');

    const part = await req.file();
    if (!part || part.fieldname !== "file") throw fileError('Send the file in a field named "file".');

    let data: Buffer;
    try {
      data = await part.toBuffer(); // throws when the file is over the size limit
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw fileError(`That file is larger than ${this.config.MAX_UPLOAD_MB} MB.`);
      throw err;
    }
    if (part.file.truncated) throw fileError(`That file is larger than ${this.config.MAX_UPLOAD_MB} MB.`);

    const newId = await this.documents.uploadFile(user.id, collectionResourceId, { filename: part.filename, data });
    return respond.acceptedDone(newId, "Document queued for processing.");
  }

  @Post("collections/:resourceId/documents/url")
  async addUrl(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", collectionId()) collectionResourceId: string,
    @Body(new ZodValidationPipe(addUrlSchema)) body: AddUrlInput,
  ) {
    return respond.acceptedDone(await this.documents.addUrl(user.id, collectionResourceId, body), "URL queued for processing.");
  }

  @Post("documents/:resourceId/reprocess")
  async reprocess(@CurrentUser() user: AuthUser, @Param("resourceId", documentId()) resourceId: string) {
    await this.documents.reprocess(user.id, resourceId);
    return respond.acceptedDone(resourceId, "Document queued for processing.");
  }

  @Delete("documents/:resourceId")
  async remove(@CurrentUser() user: AuthUser, @Param("resourceId", documentId()) resourceId: string) {
    await this.documents.remove(user.id, resourceId);
    return respond.done("Document deleted.", resourceId);
  }
}
