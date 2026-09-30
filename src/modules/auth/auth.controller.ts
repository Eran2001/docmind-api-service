import "@fastify/cookie";
import { Body, Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { respond } from "../../common/http/api-response";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthUser } from "../../common/types/fastify";
import { InjectConfig } from "../../config/config.module";
import { AUTH, COOKIES } from "../../config/constants";
import type { Env } from "../../config/env.schema";
import { AuthService, type IssuedSession } from "./auth.service";
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from "./dto/auth.schemas";

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
    return respond.created(session, session.user.id, "Account created.");
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput, @Res({ passthrough: true }) reply: FastifyReply) {
    const { session, refreshToken }: IssuedSession = await this.auth.login(body);
    this.setRefreshCookie(reply, refreshToken);
    return respond.ok(session, "Signed in.");
  }

  /** The web app calls this on every page load with its stored token to confirm the session and get the user. */
  @Get("me")
  async me(@CurrentUser() current: AuthUser) {
    const user = await this.auth.me(current.id);
    return respond.ok({ user }, "OK");
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    void reply.setCookie(COOKIES.REFRESH, token, {
      httpOnly: true, // JavaScript can't read it, so an XSS bug can't steal the long-lived token
      sameSite: "lax",
      secure: this.config.NODE_ENV === "production",
      path: AUTH.REFRESH_COOKIE_PATH,
      maxAge: AUTH.REFRESH_TTL_SECONDS,
    });
  }
}
