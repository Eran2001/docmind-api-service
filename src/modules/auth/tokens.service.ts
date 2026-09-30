import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "node:crypto";

import { AUTH } from "../../config/constants";
import type { AuthUser } from "../../common/types/fastify";

interface AccessPayload {
  sub: string;
  role: "user" | "admin";
}

@Injectable()
export class TokensService {
  constructor(private readonly jwt: JwtService) {}

  /** Short-lived HS256 JWT `{ sub, role }` that the web app sends as `Authorization: Bearer`. */
  signAccess(user: AuthUser): Promise<string> {
    const payload: AccessPayload = { sub: user.id, role: user.role };
    return this.jwt.signAsync(payload, { expiresIn: AUTH.ACCESS_TTL_SECONDS });
  }

  /** Throws when the token is malformed, tampered with, or expired. */
  async verifyAccess(token: string): Promise<AuthUser> {
    const payload = await this.jwt.verifyAsync<AccessPayload>(token);
    return { id: payload.sub, role: payload.role === "admin" ? "admin" : "user" };
  }

  /** 48 random bytes, base64url. Returned once, in the httpOnly cookie. */
  newRefreshToken(): string {
    return randomBytes(48).toString("base64url");
  }

  hashRefreshToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
