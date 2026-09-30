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
    const [row] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return row;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  }

  async create(input: { email: string; passwordHash: string; name: string }): Promise<UserRow> {
    const [row] = await this.db.insert(users).values(input).returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  }
}
