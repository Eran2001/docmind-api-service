import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, ne } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import { refreshTokens } from "../../database/schema";

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;

@Injectable()
export class RefreshTokensRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Only the sha256 of the token is stored, never the token itself. */
  async create(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<RefreshTokenRow> {
    const [row] = await this.db.insert(refreshTokens).values(input).returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRow | undefined> {
    const [row] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
    return row;
  }

  /** Revokes one token. True only for the caller that actually flipped it, so two racing refreshes can't both win. */
  async revoke(id: string): Promise<boolean> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length > 0;
  }

  /** Every active session of a user (theft response, password change). `exceptId` keeps one alive. */
  async revokeAllForUser(userId: string, exceptId?: string): Promise<void> {
    const conditions = [eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)];
    if (exceptId) conditions.push(ne(refreshTokens.id, exceptId));
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(...conditions));
  }
}
