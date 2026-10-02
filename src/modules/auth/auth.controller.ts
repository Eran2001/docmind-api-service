import "@fastify/cookie";
import "@fastify/multipart";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { RawResponse } from "../../common/decorators/raw-response.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { NoDemo } from "../../common/decorators/no-demo.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { AppError } from "../../common/errors/app-error";
import { respond } from "../../common/http/api-response";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { InjectConfig } from "../../config/config.module";
import { AUTH, COOKIES } from "../../config/constants";
import type { Env } from "../../config/env.schema";
import { DemoService } from "../demo/demo.service";
import { AuthService, type IssuedSession } from "./auth.service";
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
  type ChangePasswordInput,
  type LoginInput,
  type RegisterInput,
  type UpdateProfileInput,
} from "./dto/auth.schemas";

/** Spec 8.4: auth routes allow 10 calls a minute per IP, counted together. */
const AUTH_LIMIT = {
  name: "auth",
  limit: 10,
  windowSeconds: 60,
  by: "ip",
} as const;

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly demo: DemoService,
    @InjectConfig() private readonly config: Env,
  ) {}

  @Public()
  @RateLimit(AUTH_LIMIT)
  @Post("register")
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { session, refreshToken } = await this.auth.register(body);
    this.setRefreshCookie(reply, refreshToken);
    return respond.created(
      session,
      session.user.resourceId,
      "Account created.",
    );
  }

  /** "Try the demo": a private sandbox account (a copy of the sample collection), signed in. Same response as login. */
  @Public()
  @RateLimit({ name: "demo", limit: 5, windowSeconds: 3600, by: "ip" })
  @Post("demo")
  async startDemo(@Res({ passthrough: true }) reply: FastifyReply) {
    const { session, refreshToken } = await this.demo.start();
    this.setRefreshCookie(reply, refreshToken);
    return respond.created(session, session.user.resourceId, "Demo started.");
  }

  @Public()
  @RateLimit(AUTH_LIMIT)
  @Post("login")
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { session, refreshToken }: IssuedSession =
      await this.auth.login(body);
    this.setRefreshCookie(reply, refreshToken);
    return respond.ok(session, "Signed in.");
  }

  /**
   * Public because the access token has usually expired by now; the httpOnly refresh cookie is the credential.
   * Returns a NEW access token in `data` and rotates the cookie.
   */
  @Public()
  @RateLimit(AUTH_LIMIT)
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    try {
      const { session, refreshToken } = await this.auth.refresh(
        this.refreshCookie(req),
      );
      this.setRefreshCookie(reply, refreshToken);
      return respond.ok(session, "Session refreshed.");
    } catch (err) {
      if (err instanceof AppError && err.code === "Unauthorized")
        this.clearRefreshCookie(reply); // don't keep a dead cookie
      throw err;
    }
  }

  /** Public so it works even when the access token has expired. Always succeeds. */
  @Public()
  @Post("logout")
  @HttpCode(200)
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.logout(this.refreshCookie(req));
    this.clearRefreshCookie(reply);
    return respond.done("Signed out.");
  }

  /** The web app calls this on every page load with its stored token to confirm the session and get the user. */
  @Get("me")
  async me(@CurrentUser() current: AuthUser) {
    return respond.ok({ user: await this.auth.me(current.id) });
  }

  @NoDemo()
  @Patch("me")
  async updateMe(
    @CurrentUser() current: AuthUser,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput,
  ) {
    return respond.ok(
      { user: await this.auth.updateProfile(current.id, body) },
      "Profile updated.",
    );
  }

  /** multipart/form-data with one `file` field: a PNG, JPEG or WebP up to 2 MB. */
  @NoDemo()
  @Post("me/avatar")
  @HttpCode(200)
  async setAvatar(
    @CurrentUser() current: AuthUser,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw AppError.validation(
        'Send the picture as multipart/form-data in a field named "file".',
      );
    const part = await req.file();
    if (!part || part.fieldname !== "file")
      throw AppError.validation('Send the picture in a field named "file".');
    let data: Buffer;
    try {
      data = await part.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
        throw AppError.validation("Use a picture of 2 MB or less.");
      throw err;
    }
    await this.auth.setAvatar(current.id, data);
    return respond.done("Avatar updated.", current.id);
  }

  /** The picture itself (not JSON). It needs the Bearer token, so the web app loads it with a request and not an <img src>. */
  @RawResponse()
  @Get("me/avatar")
  async getAvatar(
    @CurrentUser() current: AuthUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { data, mimeType } = await this.auth.getAvatar(current.id);
    void reply
      .header("Content-Type", mimeType)
      .header("Cache-Control", "private, no-store");
    return data;
  }

  @NoDemo()
  @Delete("me/avatar")
  @HttpCode(200)
  async removeAvatar(@CurrentUser() current: AuthUser) {
    await this.auth.removeAvatar(current.id);
    return respond.done("Avatar removed.", current.id);
  }

  @NoDemo()
  @RateLimit(AUTH_LIMIT)
  @Post("change-password")
  @HttpCode(200)
  async changePassword(
    @CurrentUser() current: AuthUser,
    @Body(new ZodValidationPipe(changePasswordSchema))
    body: ChangePasswordInput,
    @Req() req: FastifyRequest,
  ) {
    await this.auth.changePassword(current.id, body, this.refreshCookie(req));
    return respond.done(
      "Password updated. Other devices were signed out.",
      current.id,
    );
  }

  @NoDemo()
  @Delete("me")
  @HttpCode(200)
  async deleteMe(
    @CurrentUser() current: AuthUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.auth.deleteAccount(current.id);
    this.clearRefreshCookie(reply);
    return respond.done("Account deleted.", current.id);
  }

  private refreshCookie(req: FastifyRequest): string | undefined {
    return req.cookies?.[COOKIES.REFRESH] || undefined;
  }

  private cookieOptions() {
    return {
      httpOnly: true, // JavaScript can't read it, so an XSS bug can't steal the long-lived token
      sameSite: "lax" as const,
      secure: this.config.NODE_ENV === "production",
      path: AUTH.REFRESH_COOKIE_PATH,
    };
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    void reply.setCookie(COOKIES.REFRESH, token, {
      ...this.cookieOptions(),
      maxAge: AUTH.REFRESH_TTL_SECONDS,
    });
  }

  private clearRefreshCookie(reply: FastifyReply): void {
    void reply.clearCookie(COOKIES.REFRESH, this.cookieOptions());
  }
}
