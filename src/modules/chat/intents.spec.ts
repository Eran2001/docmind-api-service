import { describe, expect, it } from "vitest";

import {
  detectIntent,
  directReply,
  libraryReply,
  notFoundReply,
  type LibraryOverview,
} from "./intents";

const overview: LibraryOverview = {
  name: "My Collection",
  documents: [
    { title: "handbook.md", status: "ready" },
    { title: "faq.md", status: "ready" },
    { title: "draft.pdf", status: "processing" },
  ],
};

describe("detectIntent", () => {
  it.each([
    "hello",
    "Hello!",
    "hi",
    "Hey there",
    "hi, how are you?",
    "How are you doing today?",
    "good morning",
    "what's up",
    "ok",
    "okay cool",
    "yo",
  ])("greeting: %s", (q) => expect(detectIntent(q)).toBe("greeting"));

  it.each([
    "thanks",
    "Thank you!",
    "thanks a lot",
    "thank you so much",
    "bye",
    "goodbye",
    "cheers",
  ])("thanks: %s", (q) => expect(detectIntent(q)).toBe("thanks"));

  it.each([
    "help",
    "what can you do?",
    "How does this work",
    "who are you",
    "what can I ask you",
  ])("help: %s", (q) => expect(detectIntent(q)).toBe("help"));

  it.each([
    "how many docs have I uploaded",
    "How many documents do I have?",
    "how many files are in this collection",
    "how many documents are there",
    "number of documents",
    "list my documents",
    "what documents do I have",
    "which files have I uploaded?",
    "show my files",
    "what files are in this collection",
  ])("library: %s", (q) => expect(detectIntent(q)).toBe("library"));

  it.each([
    // real questions that only start like small talk or mention files
    "hi, what is the refund policy?",
    "hello can you tell me how many days of PTO I get",
    "How many days of paid time off do employees get each year?",
    "what does the handbook say about uploaded files",
    "how many files can I upload",
    "what file types are supported",
    "what is the maximum file size",
    "How many documents does the expense policy mention?",
    "ok so what about contractors",
    "thanks, what is the leave policy",
    "list the steps to file an expense claim",
    "",
    "   ",
  ])("goes to search: %s", (q) => expect(detectIntent(q)).toBeNull());
});

describe("replies", () => {
  it("lists the library with the status of unfinished documents", () => {
    const text = libraryReply(overview);
    expect(text).toContain(
      "**My Collection** has 3 documents (2 ready, 1 not ready yet)",
    );
    expect(text).toContain("- handbook.md\n- faq.md\n- draft.pdf (processing)");
  });

  it("says so when the collection is empty", () => {
    expect(libraryReply({ name: "Empty", documents: [] })).toContain(
      "no documents yet",
    );
  });

  it("caps a very long list", () => {
    const many: LibraryOverview = {
      name: "Big",
      documents: Array.from({ length: 25 }, (_, i) => ({
        title: `d${i}.md`,
        status: "ready",
      })),
    };
    expect(libraryReply(many)).toContain("…and 5 more");
  });

  it("greets, thanks and helps without inventing anything", () => {
    expect(directReply("greeting", overview)).toContain("2 documents");
    expect(directReply("greeting", { name: "X", documents: [] })).toContain(
      "Upload a document",
    );
    expect(directReply("thanks", overview)).toContain("You're welcome");
    expect(directReply("help", overview)).toContain("**handbook.md**");
  });

  it("points a not-found answer at what the documents cover", () => {
    expect(notFoundReply(overview)).toBe(
      "I couldn't find that in your documents. Try asking about what they contain: **handbook.md**, **faq.md**.",
    );
    expect(notFoundReply({ name: "X", documents: [] })).toBe(
      "I couldn't find that in your documents.",
    );
  });
});
