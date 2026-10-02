import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import { users } from "../../database/schema";

export type UserRow = typeof users.$inferSelect;

/** All SQL for the users table lives here. */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row;
  }

  async updateProfile(
    id: string,
    input: { name: string; email: string },
  ): Promise<UserRow | undefined> {
    const [row] = await this.db
      .update(users)
      .set(input)
      .where(eq(users.id, id))
      .returning();
    return row;
  }

  async setAvatarPath(
    id: string,
    avatarPath: string | null,
  ): Promise<string | null | undefined> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ avatarPath: users.avatarPath })
        .from(users)
        .where(eq(users.id, id))
        .for("update")
        .limit(1);
      if (!before) return undefined;
      await tx.update(users).set({ avatarPath }).where(eq(users.id, id));
      return before.avatarPath;
    });
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, id));
  }

  /** Cascades to refresh tokens, collections, documents, chats, feedback and evals (see the schema). */
  async delete(id: string): Promise<void> {
    await this.db.delete(users).where(eq(users.id, id));
  }

  async create(input: {
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<UserRow> {
    const [row] = await this.db.insert(users).values(input).returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  }
}
