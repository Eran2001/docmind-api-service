import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BENCH_FILES, BENCH_QUESTIONS, type BenchDocKey } from "./seed-bench";

const flat = (text: string) => text.replace(/\s+/g, " ");
const corpus = (key: BenchDocKey) =>
  flat(
    readFileSync(join(process.cwd(), "bench/corpus", BENCH_FILES[key]), "utf8"),
  );

describe("the DocMind docs benchmark", () => {
  it("has 40 questions in the planned mix", () => {
    expect(BENCH_QUESTIONS).toHaveLength(40);
    const kinds: Record<string, number> = {};
    for (const q of BENCH_QUESTIONS) kinds[q.kind] = (kinds[q.kind] ?? 0) + 1;
    expect(kinds).toEqual({
      needle: 12,
      paraphrase: 8,
      readme: 10,
      exact: 4,
      unanswerable: 6,
    });
  });

  it("asks every question once", () => {
    const questions = BENCH_QUESTIONS.map((q) => q.question.toLowerCase());
    expect(new Set(questions).size).toBe(questions.length);
  });

  it("only expects answers that are really in the document it points at", () => {
    for (const q of BENCH_QUESTIONS.filter(
      (item) => item.kind !== "unanswerable",
    )) {
      expect(q.doc, q.question).toBeDefined();
      expect(corpus(q.doc!), `${q.question} -> "${q.evidence}"`).toContain(
        q.evidence!,
      );
    }
  });

  it("gives unanswerable questions no document, and no document mentions what they ask about", () => {
    const all = (["spec", "api", "web", "ai"] as const)
      .map(corpus)
      .join(" ")
      .toLowerCase();
    for (const word of [
      "ceo",
      "kubernetes",
      "uptime",
      "sentry",
      "error-tracking",
      "export a conversation",
    ]) {
      expect(all, word).not.toContain(word);
    }
    for (const q of BENCH_QUESTIONS.filter(
      (item) => item.kind === "unanswerable",
    ))
      expect(q.doc).toBeUndefined();
  });
});
