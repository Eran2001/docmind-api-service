import "@fastify/cookie";
import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { AppError } from "../../common/errors/app-error";
import { respond } from "../../common/http/api-response";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { InjectConfig } from "../../config/config.module";
import { AUTH, COOKIES } from "../../config/constants";
import type { Env } from "../../config/env.schema";
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

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @InjectConfig() private readonly config: Env,
  ) {}

  @Public()
  @Post("register")
  async register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterInput, @Res({ passthrough: true }) reply: FastifyReply) {
    const { session, refreshToken } = await this.auth.register(body);
    this.setRefreshCookie(reply, refreshToken);
    return respond.created(session, session.user.resourceId, "Account created.");
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput, @Res({ passthrough: true }) reply: FastifyReply) {
    const { session, refreshToken }: IssuedSession = await this.auth.login(body);
    this.setRefreshCookie(reply, refreshToken);
    return respond.ok(session, "Signed in.");
  }

  /**
   * Public because the access token has usually expired by now; the httpOnly refresh cookie is the credential.
   * Returns a NEW access token in `data` and rotates the cookie.
   */
  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    try {
      const { session, refreshToken } = await this.auth.refresh(this.refreshCookie(req));
      this.setRefreshCookie(reply, refreshToken);
      return respond.ok(session, "Session refreshed.");
    } catch (err) {
      if (err instanceof AppError && err.code === "Unauthorized") this.clearRefreshCookie(reply); // don't keep a dead cookie
      throw err;
    }
  }

  /** Public so it works even when the access token has expired. Always succeeds. */
  @Public()
  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(this.refreshCookie(req));
    this.clearRefreshCookie(reply);
    return respond.done("Signed out.");
  }

  /** The web app calls this on every page load with its stored token to confirm the session and get the user. */
  @Get("me")
  async me(@CurrentUser() current: AuthUser) {
    return respond.ok({ user: await this.auth.me(current.id) });
  }

  @Patch("me")
  async updateMe(@CurrentUser() current: AuthUser, @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput) {
    return respond.ok({ user: await this.auth.updateProfile(current.id, body) }, "Profile updated.");
  }

  @Post("change-password")
  @HttpCode(200)
  async changePassword(
    @CurrentUser() current: AuthUser,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @Req() req: FastifyRequest,
  ) {
    await this.auth.changePassword(current.id, body, this.refreshCookie(req));
    return respond.done("Password updated. Other devices were signed out.", current.id);
  }

  @Delete("me")
  @HttpCode(200)
  async deleteMe(@CurrentUser() current: AuthUser, @Res({ passthrough: true }) reply: FastifyReply) {
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
    void reply.setCookie(COOKIES.REFRESH, token, { ...this.cookieOptions(), maxAge: AUTH.REFRESH_TTL_SECONDS });
  }

  private clearRefreshCookie(reply: FastifyReply): void {
    void reply.clearCookie(COOKIES.REFRESH, this.cookieOptions());
  }
}
