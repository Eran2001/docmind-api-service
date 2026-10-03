#!/usr/bin/env node
// Runs an eval set on a running API and prints the scores per question type.
//   node bench/run-eval.mjs "DocMind docs benchmark" [--top-k 8] [--run <id>] [--api http://localhost:4001] [--email ...] [--password ...]
// Needs the API, the worker and the AI service running, and the seed (npm run db:seed:bench).
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const setName = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "DocMind docs benchmark";
const api = `${flag("api", "http://localhost:4001")}/api/v1`;
const topK = flag("top-k") ? Number(flag("top-k")) : undefined;

async function call(path, token, body) {
  const res = await fetch(api + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.message ?? res.status}`);
  return json;
}

const token = (await call("/auth/login", null, { email: flag("email", "demo@docmind.dev"), password: flag("password", "demo1234") })).data.accessToken;
const sets = (await call("/evals/sets", token)).data.result;
const set = sets.find((s) => s.name === setName);
if (!set) throw new Error(`No eval set named "${setName}". Sets: ${sets.map((s) => s.name).join(", ")}`);
// --run <id> prints the summary of a run that already finished instead of starting a new one.
const existing = flag("run");
const started = existing
  ? { resourceId: existing }
  : await call(`/evals/sets/${set.resourceId}/runs`, token, topK ? { topK } : {});
if (!existing) process.stderr.write(`Run ${started.resourceId} started (${setName}${topK ? `, top-k ${topK}` : ""})...\n`);

let run;
for (;;) {
  run = (await call(`/evals/runs/${started.resourceId}`, token)).data;
  if (run.status === "done" || run.status === "failed") break;
  await new Promise((r) => setTimeout(r, 8000));
}

// Question types are written next to each question in the seed files.
const kinds = {};
for (const file of ["../src/seed-bench.ts", "../src/seed-data.ts"]) {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  for (const m of src.matchAll(/kind:\s*"(\w+)",[\s\S]*?question:\s*"((?:[^"\\]|\\.)*)"/g)) kinds[m[2].replace(/\\"/g, '"')] = m[1];
}
const by = new Map();
for (const r of run.results) {
  const kind = kinds[r.question] ?? "?";
  by.set(kind, [...(by.get(kind) ?? []), r]);
}
const avg = (rows, key) => rows.reduce((t, r) => t + (typeof r[key] === "boolean" ? Number(r[key]) : r[key]), 0) / rows.length;
console.log(
  `status ${run.status} | correctness ${run.avgCorrectness?.toFixed(3)} | faithfulness ${run.avgFaithfulness?.toFixed(3)} | retrieval hit ${run.retrievalHitRate?.toFixed(3)}` +
    ` | tokens ${run.totalTokens} | cost $${(run.totalCostUsd ?? 0).toFixed(4)} | judge ${run.judgeModel} | ${Math.round((run.durationMs ?? 0) / 1000)}s`,
);
console.log(`\n${"type".padEnd(14)} ${"n".padStart(3)} ${"correct".padStart(8)} ${"faithful".padStart(9)} ${"hit".padStart(6)}`);
for (const [kind, rows] of [...by].sort()) {
  console.log(`${kind.padEnd(14)} ${String(rows.length).padStart(3)} ${avg(rows, "correctness").toFixed(2).padStart(8)} ${avg(rows, "faithfulness").toFixed(2).padStart(9)} ${avg(rows, "retrievalHit").toFixed(2).padStart(6)}`);
}
const bad = run.results.filter((r) => r.correctness < 1 || r.faithfulness < 1 || !r.retrievalHit);
if (bad.length) console.log("\nNot perfect:");
for (const r of bad) {
  console.log(`- c=${r.correctness.toFixed(2)} f=${r.faithfulness.toFixed(2)} hit=${r.retrievalHit} [${kinds[r.question] ?? "?"}] ${r.question}`);
  console.log(`    expected: ${r.expectedAnswer.slice(0, 100)}`);
  console.log(`    got:      ${r.generatedAnswer.slice(0, 160).replace(/\n/g, " ")}`);
}
