import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";

import { DB, type Database } from "../../database/database.module";
import { usageEvents, users } from "../../database/schema";

export interface UsageTotalsRow {
  costUsd: number;
  tokens: number;
  requests: number;
  avgLatencyMs: number;
}

export interface UsageDailyRow {
  date: string;
  costUsd: number;
  requests: number;
}

export interface UsageKindRow {
  kind: string;
  costUsd: number;
  tokens: number;
  requests: number;
}

export interface UsageTopUserRow {
  resourceId: string;
  name: string;
  email: string;
  costUsd: number;
  tokens: number;
  requests: number;
}

export interface UsageEventRow {
  /** Null once the user's account is deleted. */
  userName: string | null;
  userEmail: string | null;
  createdAt: Date;
  kind: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number | null;
}

/** A safety cap for one export; 365 days of a very busy account still fits. */
export const EXPORT_MAX_ROWS = 100_000;

const cost = sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`;
const tokens = sql<string>`coalesce(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)`;
const requests = sql<string>`count(*)`;

@Injectable()
export class UsageRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Totals for events in [from, to). A null `userId` means every user (the admin view). */
  async totals(
    userId: string | null,
    from: Date,
    to: Date,
  ): Promise<UsageTotalsRow> {
    const [row] = await this.db
      .select({
        cost,
        tokens,
        requests,
        latency: sql<string | null>`avg(${usageEvents.latencyMs})`,
      })
      .from(usageEvents)
      .where(this.window(userId, from, to));
    return {
      costUsd: Number(row?.cost ?? 0),
      tokens: Number(row?.tokens ?? 0),
      requests: Number(row?.requests ?? 0),
      avgLatencyMs: Math.round(Number(row?.latency ?? 0)),
    };
  }

  /** One row per UTC day that has events; days without events are filled in by the service. */
  async daily(
    userId: string | null,
    from: Date,
    to: Date,
  ): Promise<UsageDailyRow[]> {
    const day = sql<string>`to_char(${usageEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const rows = await this.db
      .select({ date: day, cost, requests })
      .from(usageEvents)
      .where(this.window(userId, from, to))
      .groupBy(day);
    return rows.map((row) => ({
      date: row.date,
      costUsd: Number(row.cost),
      requests: Number(row.requests),
    }));
  }

  async byKind(
    userId: string | null,
    from: Date,
    to: Date,
  ): Promise<UsageKindRow[]> {
    const rows = await this.db
      .select({ kind: usageEvents.kind, cost, tokens, requests })
      .from(usageEvents)
      .where(this.window(userId, from, to))
      .groupBy(usageEvents.kind);
    return rows.map((row) => ({
      kind: row.kind,
      costUsd: Number(row.cost),
      tokens: Number(row.tokens),
      requests: Number(row.requests),
    }));
  }

  /** Every event in [from, to), oldest first, for the CSV export. A null `userId` means every user. */
  async events(
    userId: string | null,
    from: Date,
    to: Date,
  ): Promise<UsageEventRow[]> {
    return this.db
      .select({
        userName: users.name,
        userEmail: users.email,
        createdAt: usageEvents.createdAt,
        kind: usageEvents.kind,
        model: usageEvents.model,
        inputTokens: usageEvents.inputTokens,
        outputTokens: usageEvents.outputTokens,
        costUsd: usageEvents.costUsd,
        latencyMs: usageEvents.latencyMs,
      })
      .from(usageEvents)
      .leftJoin(users, eq(users.id, usageEvents.userId))
      .where(this.window(userId, from, to))
      .orderBy(asc(usageEvents.createdAt), asc(usageEvents.id))
      .limit(EXPORT_MAX_ROWS);
  }

  /** The users who spent the most in [from, to), biggest first. Deleted users have no row to show. */
  async topUsers(
    from: Date,
    to: Date,
    limit: number,
  ): Promise<UsageTopUserRow[]> {
    const rows = await this.db
      .select({
        resourceId: users.id,
        name: users.name,
        email: users.email,
        cost,
        tokens,
        requests,
      })
      .from(usageEvents)
      .innerJoin(users, eq(users.id, usageEvents.userId))
      .where(this.window(null, from, to))
      .groupBy(users.id, users.name, users.email)
      .orderBy(desc(cost), desc(requests), asc(users.id))
      .limit(limit);
    return rows.map((row) => ({
      resourceId: row.resourceId,
      name: row.name,
      email: row.email,
      costUsd: Number(row.cost),
      tokens: Number(row.tokens),
      requests: Number(row.requests),
    }));
  }

  async hasEventsBefore(userId: string | null, before: Date): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(usageEvents)
      .where(
        and(
          userId === null ? undefined : eq(usageEvents.userId, userId),
          lt(usageEvents.createdAt, before),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private window(userId: string | null, from: Date, to: Date) {
    return and(
      userId === null ? undefined : eq(usageEvents.userId, userId),
      gte(usageEvents.createdAt, from),
      lt(usageEvents.createdAt, to),
    );
  }
}
