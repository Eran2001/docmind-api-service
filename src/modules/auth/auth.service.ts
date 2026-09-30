import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";

import { AppError } from "../../common/errors/app-error";
import { AUTH } from "../../config/constants";
import { toPublicUser, UsersService, type PublicUser } from "../users/users.service";
import type { LoginInput, RegisterInput } from "./dto/auth.schemas";
import { RefreshTokensRepository } from "./refresh-tokens.repository";
import { TokensService } from "./tokens.service";

/** What register and login return in `data`. The refresh token travels separately, in a cookie. */
export interface AuthSession {
  accessToken: string;
  tokenType: "Bearer";
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: PublicUser;
}

export interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
}

// Verified against when the email is unknown, so "no such user" and "wrong password" take the same time.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hash("not-a-real-password"));

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    private readonly refreshTokens: RefreshTokensRepository,
  ) {}

  async register(input: RegisterInput): Promise<IssuedSession> {
    if (await this.users.findByEmail(input.email)) throw AppError.emailTaken();

    const row = await this.users
      .create({ email: input.email, name: input.name, passwordHash: await hash(input.password) })
      .catch((err: unknown) => {
        // Two sign-ups racing past the check above: the unique index on email decides.
        if ((err as { code?: string }).code === "23505") throw AppError.emailTaken();
        throw err;
      });
    return this.issue(toPublicUser(row));
  }

  async login(input: LoginInput): Promise<IssuedSession> {
    const row = await this.users.findByEmail(input.email);
    const ok = await verify(row?.passwordHash ?? (await getDummyHash()), input.password);
    // One message for both cases, so the response never reveals which emails have accounts.
    if (!row || !ok) throw AppError.unauthorized("Invalid email or password.");
    return this.issue(toPublicUser(row));
  }

  async me(userId: string): Promise<PublicUser> {
    const row = await this.users.findById(userId);
    // A valid token for a user that no longer exists (deleted account) is just an expired session.
    if (!row) throw AppError.unauthorized("Session expired. Please sign in again.");
    return toPublicUser(row);
  }

  private async issue(user: PublicUser): Promise<IssuedSession> {
    const accessToken = await this.tokens.signAccess({ id: user.id, role: user.role });
    const refreshToken = this.tokens.newRefreshToken();
    await this.refreshTokens.create({
      userId: user.id,
      tokenHash: this.tokens.hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + AUTH.REFRESH_TTL_SECONDS * 1000),
    });
    return {
      refreshToken,
      session: { accessToken, tokenType: "Bearer", expiresIn: AUTH.ACCESS_TTL_SECONDS, user },
    };
  }
}
