import { describe, expect, it } from "vitest";

import { isRetrievalHit } from "./retrieval-hit";

const chunks = [
  {
    documentId: "doc-a",
    content: "Employees get 25 days of paid\n  time off per year.",
  },
  { documentId: "doc-b", content: "Support is open Monday to Friday." },
];

describe("isRetrievalHit", () => {
  it("is a hit when there is nothing to check (an unanswerable question)", () => {
    expect(
      isRetrievalHit({ expectedDocumentId: null, expectedEvidence: null }, []),
    ).toBe(true);
  });

  it("needs a passage of the expected document", () => {
    expect(
      isRetrievalHit(
        { expectedDocumentId: "doc-a", expectedEvidence: null },
        chunks,
      ),
    ).toBe(true);
    expect(
      isRetrievalHit(
        { expectedDocumentId: "doc-z", expectedEvidence: null },
        chunks,
      ),
    ).toBe(false);
    expect(
      isRetrievalHit(
        { expectedDocumentId: "doc-a", expectedEvidence: null },
        [],
      ),
    ).toBe(false);
  });

  it("with evidence, needs the phrase in the retrieved text, ignoring case and line breaks", () => {
    const question = {
      expectedDocumentId: "doc-a",
      expectedEvidence: "25 days of paid time off",
    };

    expect(isRetrievalHit(question, chunks)).toBe(true);
    expect(
      isRetrievalHit(
        { ...question, expectedEvidence: "30 days of paid time off" },
        chunks,
      ),
    ).toBe(false);
  });

  it("is a miss when the right document came back but not the passage with the answer", () => {
    const question = {
      expectedDocumentId: "doc-b",
      expectedEvidence: "25 days",
    };

    expect(isRetrievalHit(question, chunks)).toBe(false);
  });

  it("can check the evidence alone", () => {
    expect(
      isRetrievalHit(
        { expectedDocumentId: null, expectedEvidence: "Monday to Friday" },
        chunks,
      ),
    ).toBe(true);
  });
});
