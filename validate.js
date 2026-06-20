#!/usr/bin/env node
// Validate a "Previously on AI" items.json file.
// Usage: node validate.js out/items.json   (exits non-zero on any problem)
const fs = require("fs");

const KW = ["LLM Agents", "Python", "OpenAI", "Claude", "LangChain", "Vector DB", "MLOps", "Data Engineering", "Kubernetes", "Open Source"];
const FIELDS = ["id", "title_en", "title_ko", "summary_en", "summary_ko", "why_en", "why_ko", "who_en", "who_ko", "try_en", "try_ko", "source", "source_url", "published_at", "category", "score", "relevance_score", "tags"];

const path = process.argv[2];
if (!path) { console.error("usage: validate.js <items.json>"); process.exit(2); }

let d;
try { d = JSON.parse(fs.readFileSync(path, "utf8")); }
catch (e) { console.error("[validate] invalid JSON: " + e.message); process.exit(1); }

if (!Array.isArray(d.items) || d.items.length === 0) { console.error("[validate] no items"); process.exit(1); }

for (const it of d.items) {
  for (const f of FIELDS) {
    if (it[f] === undefined || it[f] === "") { console.error(`[validate] missing ${f} in ${it.id || "?"}`); process.exit(1); }
  }
  for (const t of (it.tags || [])) {
    if (!KW.includes(t)) { console.error(`[validate] bad tag "${t}" in ${it.id}`); process.exit(1); }
  }
}

if (d.source_count !== d.items.length) {
  console.error(`[validate] source_count (${d.source_count}) != items.length (${d.items.length})`); process.exit(1);
}

console.log(`[validate] OK — ${d.items.length} items`);
