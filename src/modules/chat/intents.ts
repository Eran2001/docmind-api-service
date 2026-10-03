/**
 * Messages that aren't questions about the contents of the documents, recognised by simple rules (no model call, so they cost
 * nothing and answer instantly):
 *   greeting  "hello", "how are you", "ok"
 *   thanks    "thanks", "thank you", "bye"
 *   help      "what can you do", "how does this work"
 *   library   "how many docs have I uploaded", "list my files": answered from the database, not from document text
 * The rules are deliberately strict (the whole message must match) so a real question that merely starts with "hi" or mentions
 * "files" still goes to search.
 */
export type Intent = "greeting" | "thanks" | "help" | "library";

export interface LibraryOverview {
  name: string;
  documents: { title: string; status: string }[];
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Longest first, so "good morning" wins over a shorter phrase.
const GREETING_PHRASES = [
  "how are you doing today",
  "how are you doing",
  "how are you today",
  "good afternoon",
  "good evening",
  "good morning",
  "how are you",
  "how's it going",
  "how is it going",
  "what's up",
  "whats up",
  "greetings",
  "good day",
  "hello",
  "hiya",
  "heya",
  "howdy",
  "hola",
  "hey",
  "hii",
  "hi",
  "yo",
  "sup",
  "ok",
  "okay",
  "cool",
  "nice",
  "great",
  "got it",
  "alright",
  "sure",
];
const THANKS_PHRASES = [
  "thank you so much",
  "thank you very much",
  "thanks a lot",
  "thanks so much",
  "many thanks",
  "thank you",
  "thanks",
  "thx",
  "cheers",
  "goodbye",
  "good night",
  "see you",
  "bye",
];
const ADDRESSEES = new Set([
  "there",
  "again",
  "docmind",
  "bot",
  "friend",
  "team",
  "all",
  "everyone",
  "please",
]);

/** True when the whole message is made of the given phrases (plus a word like "there"), e.g. "hello there", "hi how are you". */
function consistsOf(text: string, phrases: string[]): boolean {
  let rest = text;
  let matched = false;
  for (let guard = 0; guard < 4 && rest; guard++) {
    const phrase = phrases.find((p) => rest === p || rest.startsWith(`${p} `));
    if (phrase) {
      matched = true;
      rest = rest.slice(phrase.length).trim();
      continue;
    }
    const word = rest.split(" ")[0] ?? "";
    if (matched && ADDRESSEES.has(word)) {
      rest = rest.slice(word.length).trim();
      continue;
    }
    return false;
  }
  return matched && rest === "";
}

const HELP =
  /^(?:(?:please|can you|could you) )?(?:help(?: me)?|what can you do|what do you do|what can i ask(?: you)?|how does this work|how do i use (?:this|you|it|docmind)|who are you|what are you|what is this|what is docmind|how can you help(?: me)?)(?: docmind| please)?$/;

const DOCS = "(?:documents?|docs?|files?|pdfs?)";
// "how many docs have I uploaded", "how many files are in this collection", "number of documents"
const LIBRARY_COUNT = new RegExp(
  `^(?:please |can you |could you )?(?:tell me )?(?:how many (?:\\w+ )?${DOCS}|(?:the )?(?:number|count|total) of (?:my |the |all )?${DOCS})(?: \\w+){0,6}$`,
);
// "list my documents", "what files do I have", "which documents have I uploaded", "show my files"
const LIBRARY_LIST = new RegExp(
  `^(?:please |can you |could you )?(?:tell me |show me |list )?(?:(?:list|show|display|see|what|which)(?: \\w+){0,3} ${DOCS}(?: \\w+){0,5}|(?:my |the |all )?${DOCS}(?: \\w+){0,4})$`,
);
// The bare forms need no other hint: "list my documents", "show my files", "number of documents".
const LIBRARY_BARE = new RegExp(
  `^(?:please |can you |could you )?(?:(?:list|show|display|see)(?: me)? (?:my |the |all |all my |all the )${DOCS}|(?:the )?(?:number|count|total) of (?:my |the |all )?${DOCS})$`,
);
const LIBRARY_HINT =
  /\b(?:have|has|uploaded|upload|added|in (?:this|my|the)|here|there|available|got|collection)\b/;
// Questions about rules and limits ("how many files can I upload") are not about the library.
const LIMITS =
  /\b(?:can|could|may|allowed|limit|limits|maximum|max|size|mb|supported|support|types?|formats?)\b/;

export function detectIntent(question: string): Intent | null {
  const text = normalize(question);
  if (!text || text.length > 80 || text.split(" ").length > 10) return null;
  if (consistsOf(text, GREETING_PHRASES)) return "greeting";
  if (consistsOf(text, THANKS_PHRASES)) return "thanks";
  if (HELP.test(text)) return "help";
  if (LIBRARY_BARE.test(text)) return "library";
  if (
    !LIMITS.test(text) &&
    LIBRARY_HINT.test(text) &&
    (LIBRARY_COUNT.test(text) || LIBRARY_LIST.test(text))
  )
    return "library";
  return null;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const ready = (overview: LibraryOverview) =>
  overview.documents.filter((d) => d.status === "ready");

export function libraryReply(overview: LibraryOverview): string {
  const docs = overview.documents;
  if (docs.length === 0)
    return `**${overview.name}** has no documents yet. Upload some from the collection page and I can answer questions about them.`;
  const notReady = docs.length - ready(overview).length;
  const shown = docs
    .slice(0, 20)
    .map((d) => `- ${d.title}${d.status === "ready" ? "" : ` (${d.status})`}`);
  const more = docs.length > 20 ? [`- …and ${docs.length - 20} more`] : [];
  const status =
    notReady > 0
      ? ` (${ready(overview).length} ready, ${notReady} not ready yet)`
      : "";
  return `**${overview.name}** has ${plural(docs.length, "document", "documents")}${status}:\n\n${[...shown, ...more].join("\n")}`;
}

export function directReply(intent: Intent, overview: LibraryOverview): string {
  const readyDocs = ready(overview);
  switch (intent) {
    case "library":
      return libraryReply(overview);
    case "thanks":
      return `You're welcome! Ask me anything else about the documents in **${overview.name}**.`;
    case "help":
      return [
        `I answer questions about the documents in **${overview.name}**, using only what is written in them, and I show the page each answer came from. If the answer isn't there, I'll say so instead of guessing.`,
        readyDocs.length > 0
          ? `Try asking about what is in ${readyDocs
              .slice(0, 3)
              .map((d) => `**${d.title}**`)
              .join(", ")}.`
          : "Upload a document to get started.",
      ].join("\n\n");
    default:
      return readyDocs.length > 0
        ? `Hi! I can answer questions about the ${plural(readyDocs.length, "document", "documents")} in **${overview.name}** and show you the page each answer comes from. What would you like to know?`
        : `Hi! Upload a document to **${overview.name}** and I can answer questions about it, with the page each answer comes from.`;
  }
}

export const NOT_FOUND = "I couldn't find that in your documents.";

/** The "not found" answer, with a pointer to what the documents do cover. */
export function notFoundReply(overview: LibraryOverview): string {
  const titles = ready(overview).slice(0, 3);
  if (titles.length === 0) return NOT_FOUND;
  return `${NOT_FOUND} Try asking about what they contain: ${titles.map((d) => `**${d.title}**`).join(", ")}.`;
}
