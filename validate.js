#!/usr/bin/env node
// Validate a "Previously on AI" items.json file.
// Usage: node validate.js out/items.json   (exits non-zero on any problem)
const fs = require("fs");

const KW = ["LLM Agents", "Python", "OpenAI", "Claude", "LangChain", "Vector DB", "MLOps", "Data Engineering", "Kubernetes", "Open Source"];
const FIELDS = ["id", "title_en", "title_ko", "summary_en", "summary_ko", "why_en", "why_ko", "who_en", "who_ko", "try_en", "try_ko", "source", "source_url", "published_at", "category", "score", "relevance_score", "tags"];
const CATEGORIES = ["model_release", "api", "research", "framework", "other"];
const MAX_ITEMS = 20; // prompt targets 12–15; anything above this smells like a runaway run

const path = process.argv[2];
if (!path) { console.error("usage: validate.js <items.json>"); process.exit(2); }

let d;
try { d = JSON.parse(fs.readFileSync(path, "utf8")); }
catch (e) { console.error("[validate] invalid JSON: " + e.message); process.exit(1); }

const fail = (msg) => { console.error("[validate] " + msg); process.exit(1); };

if (!Array.isArray(d.items) || d.items.length === 0) fail("no items");
if (d.items.length > MAX_ITEMS) fail(`too many items (${d.items.length} > ${MAX_ITEMS})`);

const seenIds = new Set();
for (const it of d.items) {
  for (const f of FIELDS) {
    if (it[f] === undefined || it[f] === "") fail(`missing ${f} in ${it.id || "?"}`);
  }

  // id: unique, dated slug (YYYY-MM-DD-...)
  if (seenIds.has(it.id)) fail(`duplicate id "${it.id}"`);
  seenIds.add(it.id);
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/.test(it.id)) fail(`bad id format "${it.id}"`);

  // tags: non-empty subset of the canonical keywords (the site filters on them)
  if (!Array.isArray(it.tags) || it.tags.length === 0) fail(`empty tags in ${it.id}`);
  for (const t of it.tags) {
    if (!KW.includes(t)) fail(`bad tag "${t}" in ${it.id}`);
  }

  if (!CATEGORIES.includes(it.category)) fail(`bad category "${it.category}" in ${it.id}`);

  if (!Number.isInteger(it.score) || it.score < 0 || it.score > 100) fail(`bad score ${it.score} in ${it.id}`);
  if (typeof it.relevance_score !== "number" || Math.abs(it.relevance_score - it.score / 100) > 0.005) {
    fail(`relevance_score ${it.relevance_score} != score/100 in ${it.id}`);
  }

  if (Number.isNaN(Date.parse(it.published_at))) fail(`unparseable published_at "${it.published_at}" in ${it.id}`);
  if (!/^https?:\/\//.test(it.source_url)) fail(`bad source_url "${it.source_url}" in ${it.id}`);

  // related (optional) — attached by vec.js from the vector store, never by the generator
  if (it.related !== undefined) {
    if (!Array.isArray(it.related)) fail(`related is not an array in ${it.id}`);
    for (const r of it.related) {
      if (!r || !r.id || !r.title_en) fail(`bad related entry in ${it.id}`);
      if (r.id === it.id) fail(`self-referencing related in ${it.id}`);
    }
  }
}

if (d.source_count !== d.items.length) {
  fail(`source_count (${d.source_count}) != items.length (${d.items.length})`);
}
if (d.schema_version !== 2) fail(`unexpected schema_version ${d.schema_version}`);
if (Number.isNaN(Date.parse(d.generated_at))) fail(`unparseable generated_at "${d.generated_at}"`);

console.log(`[validate] OK — ${d.items.length} items`);
