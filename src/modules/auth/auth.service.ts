import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";

import { AppError } from "../../common/errors/app-error";
import { AUTH } from "../../config/constants";
import { StorageService } from "../../integrations/storage/storage.service";
import type { UserRow } from "../users/users.repository";
import {
  toPublicUser,
  UsersService,
  type PublicUser,
} from "../users/users.service";
import { AVATAR_MAX_BYTES, detectImage, mimeTypeOf } from "./avatar";
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
} from "./dto/auth.schemas";
import { RefreshTokensRepository } from "./refresh-tokens.repository";
import { TokensService } from "./tokens.service";

/** What register, login and refresh return in `data`. The refresh token travels separately, in a cookie. */
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

const SESSION_EXPIRED = "Session expired. Please sign in again.";

// Verified against when the email is unknown, so "no such user" and "wrong password" take the same time.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hash("not-a-real-password"));

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === "23505";

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly storage: StorageService,
  ) {}

  async register(input: RegisterInput): Promise<IssuedSession> {
    if (await this.users.findByEmail(input.email)) throw AppError.emailTaken();

    const row = await this.users
      .create({
        email: input.email,
        name: input.name,
        passwordHash: await hash(input.password),
      })
      .catch((err: unknown) => {
        // Two sign-ups racing past the check above: the unique index on email decides.
        if (isUniqueViolation(err)) throw AppError.emailTaken();
        throw err;
      });
    return this.issue(toPublicUser(row));
  }

  async login(input: LoginInput): Promise<IssuedSession> {
    const row = await this.users.findByEmail(input.email);
    const ok = await verify(
      row?.passwordHash ?? (await getDummyHash()),
      input.password,
    );
    // One message for both cases, so the response never reveals which emails have accounts.
    if (!row || !ok) throw AppError.unauthorized("Invalid email or password.");
    return this.issue(toPublicUser(row));
  }

  /**
   * Trades a refresh token for a new access token AND a new refresh token (rotation): each refresh token works exactly once.
   * A token that was already used is either a harmless race between tabs (inside the grace window) or a stolen copy
   * being replayed, in which case every session of that user is revoked.
   */
  async refresh(rawToken: string | undefined): Promise<IssuedSession> {
    if (!rawToken) throw AppError.unauthorized(SESSION_EXPIRED);

    const stored = await this.refreshTokens.findByHash(
      this.tokens.hashRefreshToken(rawToken),
    );
    if (!stored) throw AppError.unauthorized(SESSION_EXPIRED);

    if (stored.revokedAt) {
      if (
        Date.now() - stored.revokedAt.getTime() >
        AUTH.REFRESH_REUSE_GRACE_MS
      ) {
        await this.refreshTokens.revokeAllForUser(stored.userId);
      }
      throw AppError.unauthorized(SESSION_EXPIRED);
    }
    if (stored.expiresAt.getTime() <= Date.now())
      throw AppError.unauthorized(SESSION_EXPIRED);

    const row = await this.users.findById(stored.userId);
    if (!row) throw AppError.unauthorized(SESSION_EXPIRED);

    // Only one of two simultaneous refreshes can flip the token; the other one loses here.
    if (!(await this.refreshTokens.revoke(stored.id)))
      throw AppError.unauthorized(SESSION_EXPIRED);
    return this.issue(toPublicUser(row));
  }

  /** Revokes this browser's refresh token. Always succeeds: signing out an already signed-out browser is fine. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const stored = await this.refreshTokens.findByHash(
      this.tokens.hashRefreshToken(rawToken),
    );
    if (stored) await this.refreshTokens.revoke(stored.id);
  }

  async me(userId: string): Promise<PublicUser> {
    const row = await this.users.findById(userId);
    // A valid token for a user that no longer exists (deleted account) is just an expired session.
    if (!row) throw AppError.unauthorized(SESSION_EXPIRED);
    return toPublicUser(row);
  }

  async updateProfile(
    userId: string,
    input: UpdateProfileInput,
  ): Promise<PublicUser> {
    const row = await this.users
      .updateProfile(userId, input)
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw AppError.emailTaken();
        throw err;
      });
    if (!row) throw AppError.unauthorized(SESSION_EXPIRED);
    return toPublicUser(row);
  }

  /**
   * Changes the password and signs out every OTHER browser (their refresh tokens are revoked; `currentRefreshToken` stays valid).
   * Their short-lived access tokens keep working until they expire, at most `ACCESS_TOKEN_TTL_SECONDS`.
   */
  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    currentRefreshToken: string | undefined,
  ): Promise<void> {
    const row = await this.users.findById(userId);
    if (!row) throw AppError.unauthorized(SESSION_EXPIRED);

    if (!(await verify(row.passwordHash, input.currentPassword))) {
      // 400, not 401: a 401 would make the web app think the session is dead and sign the user out.
      const message = "Current password is incorrect.";
      throw AppError.validation(message, {
        fieldErrors: { currentPassword: [message] },
      });
    }

    await this.users.updatePasswordHash(userId, await hash(input.newPassword));

    const current = currentRefreshToken
      ? await this.refreshTokens.findByHash(
          this.tokens.hashRefreshToken(currentRefreshToken),
        )
      : undefined;
    const keep =
      current && current.userId === userId && !current.revokedAt
        ? current.id
        : undefined;
    await this.refreshTokens.revokeAllForUser(userId, keep);
  }

  /** Replaces the profile picture. Only PNG, JPEG and WebP up to 2 MB; the old file is removed afterwards. */
  async setAvatar(userId: string, data: Buffer): Promise<void> {
    if (data.length > AVATAR_MAX_BYTES)
      throw AppError.validation("Use a picture of 2 MB or less.");
    const image = detectImage(data);
    if (!image) throw AppError.validation("Use a PNG, JPEG or WebP picture.");

    const path = await this.storage.save(
      userId,
      `avatar-${randomUUID()}`,
      image.extension,
      data,
    );
    const previous = await this.users.setAvatarPath(userId, path);
    if (previous === undefined) {
      await this.storage.remove(path).catch(() => undefined);
      throw AppError.unauthorized(SESSION_EXPIRED);
    }
    await this.storage.remove(previous).catch(() => undefined);
  }

  async removeAvatar(userId: string): Promise<void> {
    const previous = await this.users.setAvatarPath(userId, null);
    if (previous === undefined) throw AppError.unauthorized(SESSION_EXPIRED);
    await this.storage.remove(previous).catch(() => undefined);
  }

  async getAvatar(userId: string): Promise<{ data: Buffer; mimeType: string }> {
    const row = await this.users.findById(userId);
    if (!row) throw AppError.unauthorized(SESSION_EXPIRED);
    if (!row.avatarPath) throw AppError.notFound("Avatar");
    const data = await this.storage.read(row.avatarPath).catch(() => {
      throw AppError.notFound("Avatar");
    });
    return { data, mimeType: mimeTypeOf(extname(row.avatarPath)) };
  }

  async deleteAccount(userId: string): Promise<void> {
    // The foreign keys cascade, so the user's tokens, collections, documents, chats and evals go with the row;
    // the uploaded files are on disk and are removed here.
    await this.users.delete(userId);
    await this.storage.removeUserFiles(userId).catch(() => undefined);
  }

  /** Signs in a user that was just created by the server itself (the demo sandbox): a session and a refresh token, no password. */
  startSessionFor(row: UserRow): Promise<IssuedSession> {
    return this.issue(toPublicUser(row));
  }

  private async issue(user: PublicUser): Promise<IssuedSession> {
    const accessToken = await this.tokens.signAccess({
      id: user.resourceId,
      role: user.role,
      demo: user.demo !== null,
    });
    const refreshToken = this.tokens.newRefreshToken();
    await this.refreshTokens.create({
      userId: user.resourceId,
      tokenHash: this.tokens.hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + AUTH.REFRESH_TTL_SECONDS * 1000),
    });
    return {
      refreshToken,
      session: {
        accessToken,
        tokenType: "Bearer",
        expiresIn: this.tokens.accessTtlSeconds,
        user,
      },
    };
  }
}
