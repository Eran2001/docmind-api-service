import { Inject, Injectable } from "@nestjs/common";

import { DB, type Database } from "../../database/database.module";
import { refreshTokens } from "../../database/schema";

@Injectable()
export class RefreshTokensRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Only the sha256 of the token is stored, never the token itself. */
  async create(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.db.insert(refreshTokens).values(input);
  }
}
