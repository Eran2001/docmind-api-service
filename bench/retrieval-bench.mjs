#!/usr/bin/env node
// Compares retrieval strategies WITHOUT calling the answer model: for every benchmark question with an evidence phrase it
// asks "is a passage containing that phrase among the top-K results?". Fast (seconds) and almost free (one embedding call),
// so it is the tool for tuning retrieval; confirm the winner with a full eval run (bench/run-eval.mjs).
//   node bench/retrieval-bench.mjs
// Reads DATABASE_URL, AI_SERVICE_URL and INTERNAL_API_KEY from .env.
import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

const COLLECTION = "DocMind Docs (benchmark)";
const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();

// ---- the questions, with their evidence ----
const src = readFileSync(new URL("../src/seed-bench.ts", import.meta.url), "utf8");
const questions = [...src.matchAll(/kind:\s*"(\w+)",\s*doc:\s*"\w+",\s*question:\s*"((?:[^"\\]|\\.)*)",[\s\S]*?evidence:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => ({
  kind: m[1],
  question: m[2].replace(/\\"/g, '"'),
  evidence: m[3].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
}));

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows: chunkRows } = await db.query(
  `SELECT c.id, c.content FROM chunks c JOIN collections col ON col.id = c.collection_id WHERE col.name = $1`,
  [COLLECTION],
);
const [{ id: collectionId }] = (await db.query(`SELECT id FROM collections WHERE name = $1 LIMIT 1`, [COLLECTION])).rows;
for (const q of questions) {
  q.relevant = new Set(chunkRows.filter((c) => norm(c.content).includes(norm(q.evidence))).map((c) => c.id));
}
// Every evidence question counts. If chunking cut the evidence phrase in two, no single chunk contains it and the question is a miss.
const answerable = questions;
const whole = questions.filter((q) => q.relevant.size > 0).length;
console.log(`${chunkRows.length} chunks, ${questions.length} questions with evidence, ${whole} whose evidence sits inside one chunk\n`);

// ---- embeddings (one call) ----
const res = await fetch(`${process.env.AI_SERVICE_URL}/embed`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Key": process.env.INTERNAL_API_KEY },
  body: JSON.stringify({ texts: answerable.map((q) => q.question) }),
});
const { embeddings } = await res.json();
answerable.forEach((q, i) => (q.vector = `[${embeddings[i].join(",")}]`));

// ---- strategies ----
/** The hybrid query with its knobs: candidates per list, RRF constant, keyword mode and per-list weights. */
async function search(q, o) {
  if (o.rerank) return searchReranked(q, o);
  if (o.threeLists) return searchThree(q, o);
  const keywordQuery = o.keyword === "or" ? `replace(plainto_tsquery('english', $3)::text, '&', '|')::tsquery` : `websearch_to_tsquery('english', $3)`;
  const { rows } = await db.query(
    `WITH vector_search AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
       FROM chunks WHERE collection_id = $2 ORDER BY embedding <=> $1::vector LIMIT ${o.candidates}
     ), keyword_search AS (
       SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, k.query) DESC) AS rank
       FROM chunks c CROSS JOIN (SELECT ${keywordQuery} AS query) AS k
       WHERE c.collection_id = $2 AND c.tsv @@ k.query ORDER BY ts_rank_cd(c.tsv, k.query) DESC LIMIT ${o.candidates}
     ), fused AS (
       SELECT id, SUM(w / (${o.rrfK} + rank)) AS score FROM (
         SELECT id, rank, ${o.vectorWeight}::numeric AS w FROM vector_search
         UNION ALL SELECT id, rank, ${o.keywordWeight}::numeric AS w FROM keyword_search
       ) s GROUP BY id
     ) SELECT id FROM fused ORDER BY score DESC LIMIT 20`,
    [q.vector, collectionId, q.question],
  );
  return rows.map((r) => r.id);
}

/** Vector + all-words keyword search + any-word keyword search, all fused with RRF. */
async function searchThree(q, o) {
  const { rows } = await db.query(
    `WITH vector_search AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank FROM chunks WHERE collection_id = $2
       ORDER BY embedding <=> $1::vector LIMIT ${o.candidates}
     ), kw_and AS (
       SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, k.query) DESC) AS rank
       FROM chunks c CROSS JOIN (SELECT websearch_to_tsquery('english', $3) AS query) AS k
       WHERE c.collection_id = $2 AND c.tsv @@ k.query LIMIT ${o.candidates}
     ), kw_or AS (
       SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(c.tsv, k.query) DESC) AS rank
       FROM chunks c CROSS JOIN (SELECT replace(plainto_tsquery('english', $3)::text, '&', '|')::tsquery AS query) AS k
       WHERE c.collection_id = $2 AND c.tsv @@ k.query ORDER BY ts_rank_cd(c.tsv, k.query) DESC LIMIT ${o.candidates}
     ), fused AS (
       SELECT id, SUM(1.0 / (${o.rrfK} + rank)) AS score
       FROM (SELECT * FROM vector_search UNION ALL SELECT * FROM kw_and UNION ALL SELECT * FROM kw_or) s GROUP BY id
     ) SELECT id FROM fused ORDER BY score DESC LIMIT 20`,
    [q.vector, collectionId, q.question],
  );
  return rows.map((r) => r.id);
}

/** Takes the top 20 of the three-list search and lets the rerank model put the best 8 first (POST /rerank on the AI service). */
const contentById = new Map(chunkRows.map((c) => [c.id, c.content]));
async function searchReranked(q, o) {
  const ids = (await searchThree(q, o)).slice(0, Number(process.env.RERANK_CANDIDATES ?? 20));
  const res = await fetch(`${process.env.AI_SERVICE_URL}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Key": process.env.INTERNAL_API_KEY },
    body: JSON.stringify({ question: q.question, passages: ids.map((id) => ({ id, text: contentById.get(id) })), top_n: 8 }),
  });
  if (!res.ok) throw new Error(`rerank failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  rerankTokens += data.usage.input_tokens + data.usage.output_tokens;
  return data.ids;
}
let rerankTokens = 0;

const base = { candidates: 30, rrfK: 60, keyword: "and", vectorWeight: 1, keywordWeight: 1 };
const strategies = [
  ["baseline (AND keywords, k=60)", base],
  ["keywords OR", { ...base, keyword: "or" }],
  ["vector + AND + OR", { ...base, threeLists: true }],
  ["+ rerank (top 20 -> 8)", { ...base, threeLists: true, rerank: true }],
  ["vector only", { ...base, keywordWeight: 0 }],
  ["keywords only (AND)", { ...base, vectorWeight: 0 }],
  ["keywords only (OR)", { ...base, vectorWeight: 0, keyword: "or" }],
  ["OR, vector 2x", { ...base, keyword: "or", vectorWeight: 2 }],
  ["OR, keywords 2x", { ...base, keyword: "or", keywordWeight: 2 }],
  ["OR, rrf k=20", { ...base, keyword: "or", rrfK: 20 }],
  ["OR, 50 candidates", { ...base, keyword: "or", candidates: 50 }],
];
const only = process.env.ONLY ? process.env.ONLY.split("|") : null;
const ks = [3, 5, 8, 12, 16];
const rows = [];
for (const [name, opts] of strategies) {
  if (only && !only.includes(name)) continue;
  const hits = Object.fromEntries(ks.map((k) => [k, 0]));
  let rr = 0;
  const missAt8 = [];
  for (const q of answerable) {
    const ids = await search(q, opts);
    const rank = ids.findIndex((id) => q.relevant.has(id)) + 1; // 0 = not found in the top 20
    if (rank > 0) rr += 1 / rank;
    for (const k of ks) if (rank > 0 && rank <= k) hits[k]++;
    if (!(rank > 0 && rank <= 8)) missAt8.push(q.question);
  }
  rows.push({ name, hits, mrr: rr / answerable.length, missAt8 });
}
const pct = (n) => `${((n / answerable.length) * 100).toFixed(0)}%`.padStart(5);
console.log(`${"strategy".padEnd(32)} ${ks.map((k) => `hit@${k}`.padStart(7)).join("")}    MRR`);
for (const r of rows) console.log(`${r.name.padEnd(32)} ${ks.map((k) => pct(r.hits[k]).padStart(7)).join("")}  ${r.mrr.toFixed(3)}`);
const worst = rows[0];
console.log(`\nMisses at top-8 for the baseline (${worst.missAt8.length}):`);
for (const m of worst.missAt8) console.log(`- ${m}`);
if (rerankTokens) console.log(`\nrerank tokens used: ${rerankTokens} over ${answerable.length} questions (${Math.round(rerankTokens / answerable.length)} per question)`);
await db.end();
