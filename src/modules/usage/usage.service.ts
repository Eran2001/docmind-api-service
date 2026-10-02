import { Injectable } from "@nestjs/common";

import { UsageRepository } from "./usage.repository";

const CSV_HEADER = [
  "created_at",
  "kind",
  "model",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "latency_ms",
];

const DAY_MS = 86_400_000;
const TOP_USERS = 10;
const KINDS = ["answer", "embed", "judge", "rewrite"] as const;

@Injectable()
export class UsageService {
  constructor(private readonly usage: UsageRepository) {}

  /** One CSV row per model call in the last `days` UTC days (UTC timestamps), oldest first. */
  async exportCsv(userId: string, days: number, now = new Date()) {
    return this.csv(userId, days, now);
  }

  /** The same file for every user, with each call's user name and email in front. */
  async exportAdminCsv(days: number, now = new Date()) {
    return this.csv(null, days, now);
  }

  private async csv(userId: string | null, days: number, now: Date) {
    const { from, to } = this.window(days, now);
    const events = await this.usage.events(userId, from, to);
    const withUser = userId === null;
    const rows = events.map((event) => [
      ...(withUser ? [event.userEmail ?? "", event.userName ?? ""] : []),
      event.createdAt.toISOString(),
      event.kind,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.costUsd,
      event.latencyMs ?? "",
    ]);
    return (
      [
        withUser ? ["user_email", "user_name", ...CSV_HEADER] : CSV_HEADER,
        ...rows,
      ]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n") + "\r\n"
    );
  }

  private window(days: number, now: Date) {
    const today = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    return {
      today,
      from: new Date(today - (days - 1) * DAY_MS),
      to: new Date(today + DAY_MS),
    };
  }

  /**
   * The user's usage over the last `days` UTC days (today included), compared with the `days` before.
   * `now` is a parameter so tests can pin the clock.
   */
  async forUser(userId: string, days: number, now = new Date()) {
    return this.summary(userId, days, now);
  }

  /** Everyone's usage plus the 10 biggest spenders (admin only; the controller checks the role). */
  async forAdmin(days: number, now = new Date()) {
    const { from, to } = this.window(days, now);
    const [summary, topUsers] = await Promise.all([
      this.summary(null, days, now),
      this.usage.topUsers(from, to, TOP_USERS),
    ]);
    return { ...summary, topUsers };
  }

  private async summary(userId: string | null, days: number, now: Date) {
    const { from, to } = this.window(days, now);
    const previousFrom = new Date(from.getTime() - days * DAY_MS);

    const [totals, dailyRows, kindRows, hasHistory] = await Promise.all([
      this.usage.totals(userId, from, to),
      this.usage.daily(userId, from, to),
      this.usage.byKind(userId, from, to),
      this.usage.hasEventsBefore(userId, from),
    ]);
    // No earlier activity means there is nothing to compare with, so the UI shows no change.
    const previous = hasHistory
      ? await this.usage.totals(userId, previousFrom, from)
      : null;

    const byDate = new Map(dailyRows.map((row) => [row.date, row]));
    const daily = Array.from({ length: days }, (_, index) => {
      const date = new Date(from.getTime() + index * DAY_MS)
        .toISOString()
        .slice(0, 10);
      return byDate.get(date) ?? { date, costUsd: 0, requests: 0 };
    });

    const byKind = KINDS.map(
      (kind) =>
        kindRows.find((row) => row.kind === kind) ?? {
          kind,
          costUsd: 0,
          tokens: 0,
          requests: 0,
        },
    );

    return { days, totals, previous, daily, byKind };
  }
}

/** Quotes a value when needed, and defuses spreadsheet formulas (a leading = + - @ would be run by Excel). */
function csvCell(value: string | number): string {
  const text = String(value);
  const safe =
    /^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
