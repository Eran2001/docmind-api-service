import { Body, Controller, Param, Post, Put, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RawResponse } from "../../common/decorators/raw-response.decorator";
import { respond } from "../../common/http/api-response";
import { UuidParamPipe } from "../../common/pipes/uuid-param.pipe";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { ConversationsService } from "../conversations/conversations.service";
import { ChatService, type ChatSseEvent } from "./chat.service";
import {
  feedbackSchema,
  sendMessageSchema,
  type FeedbackInput,
  type SendMessageInput,
} from "./dto/chat.schemas";
import { InjectConfig } from "../../config/config.module";
import type { Env } from "../../config/env.schema";

@Controller()
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly conversations: ConversationsService,
    @InjectConfig() private readonly config: Env,
  ) {}

  @RawResponse()
  @Post("conversations/:resourceId/messages")
  async sendMessage(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Conversation"))
    conversationId: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageInput,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.conversations.requireOwned(user.id, conversationId);
    reply.hijack();
    const origin = request.headers.origin;
    const corsHeaders =
      typeof origin === "string" && this.config.WEB_ORIGIN.includes(origin)
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Expose-Headers": "X-Request-Id",
            Vary: "Origin",
          }
        : {};
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-Id": request.id,
      ...corsHeaders,
    });

    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.on("close", onClose);
    const emit = (event: ChatSseEvent) => {
      if (!abort.signal.aborted && !reply.raw.writableEnded) {
        reply.raw.write(
          `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      }
    };

    try {
      await this.chat.sendMessage(
        user.id,
        conversationId,
        body.content,
        abort.signal,
        emit,
      );
    } catch {
      emit({
        event: "error",
        data: {
          code: "InternalError",
          message: "Couldn't send your message. Please try again.",
        },
      });
    } finally {
      reply.raw.off("close", onClose);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  }

  @Put("messages/:resourceId/feedback")
  async feedback(
    @CurrentUser() user: AuthUser,
    @Param("resourceId", new UuidParamPipe("Message")) messageId: string,
    @Body(new ZodValidationPipe(feedbackSchema)) body: FeedbackInput,
  ) {
    await this.chat.saveFeedback(user.id, messageId, body);
    return respond.done("Feedback saved.", messageId);
  }
}
