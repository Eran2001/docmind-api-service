import { describe, expect, it } from "vitest";

import { DOC_CONTENT, FULL_EVAL_QUESTIONS } from "./seed-data";

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("the full evaluation set", () => {
  it("has 40 questions in every category", () => {
    expect(FULL_EVAL_QUESTIONS).toHaveLength(40);
    const kinds = new Map<string, number>();
    for (const q of FULL_EVAL_QUESTIONS)
      kinds.set(q.kind, (kinds.get(q.kind) ?? 0) + 1);
    expect(Object.fromEntries(kinds)).toEqual({
      lookup: 15,
      paraphrase: 8,
      multi: 4,
      cross: 3,
      keyword: 3,
      unanswerable: 7,
    });
  });

  it("asks every question once", () => {
    const questions = FULL_EVAL_QUESTIONS.map((q) => q.question.toLowerCase());
    expect(new Set(questions).size).toBe(questions.length);
  });

  it("only expects answers that are really in the document it points at", () => {
    for (const q of FULL_EVAL_QUESTIONS.filter(
      (item) => item.kind !== "unanswerable",
    )) {
      expect(q.doc, q.question).toBeDefined();
      expect(q.evidence, q.question).toBeDefined();
      expect(
        flat(DOC_CONTENT[q.doc!]),
        `${q.question} -> "${q.evidence}"`,
      ).toContain(q.evidence!);
    }
  });

  it("gives unanswerable questions no document", () => {
    for (const q of FULL_EVAL_QUESTIONS.filter(
      (item) => item.kind === "unanswerable",
    )) {
      expect(q.doc).toBeUndefined();
    }
  });
});
