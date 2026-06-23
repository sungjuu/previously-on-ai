#!/usr/bin/env node
//
// vec.js — Cohere-backed vector store for cross-RUN deduplication.
//
// The daily generator only sees the stories it fetched this morning, so it can
// merge same-run duplicates but has no memory across days. This adds that
// memory: every published item is embedded (Cohere Embed multilingual) into a
// single-file sqlite-vec store; each run's candidates are checked against the
// last N days and near-duplicates are dropped before publish.
//
// Subcommands:
//   dedup   <items.json>   drop candidates that match a recent stored item (mutates the file)
//   embed   <items.json>   upsert the published items into the store (embed-on-publish)
//   reindex [archiveDir]   (re)build the store from archive/*.json  (default: $POA_PUBLISH_DIR/archive)
//   eval    <labels.json>  sweep thresholds over labeled pairs → precision/recall/F1
//
// Design contract (mirrors run.sh's "a bad run can't empty the site"):
//   - SOFT failures (no API key, Cohere/network/DB error) → warn and exit 0
//     WITHOUT mutating items.json. The run still validates and publishes that
//     day, just without cross-run dedup, and nothing inconsistent enters the
//     store.
//   - HARD failures (missing file, invalid JSON) → exit non-zero.
//
// Env knobs:
//   POA_STATE_DIR        where the store lives (default /var/lib/poa; never under out/ — run.sh wipes it)
//   COHERE_API_KEY       required for any embedding work (run.sh sources ./.env)
//   POA_EMBED_MODEL      default embed-multilingual-v3.0
//   POA_EMBED_DIM        embedding dimensions (default 1024 for v3)
//   POA_DEDUP_THRESHOLD  cosine similarity at/above which a candidate is a dup (default 0.85).
//                        Tuned for Cohere embed-multilingual-v3.0 and leaning toward
//                        precision: same-story paraphrases sit ~0.80–0.95, distinct
//                        stories well below, so 0.85 catches near-duplicates while
//                        sparing genuine multi-day follow-ups. Re-tune via `vec.js eval`.
//   POA_DEDUP_DAYS       retrieval window in days (default 14)

const fs = require("fs");
const path = require("path");

const STATE_DIR = process.env.POA_STATE_DIR || "/var/lib/poa";
const DB_PATH = path.join(STATE_DIR, "poa.db");
const MODEL = process.env.POA_EMBED_MODEL || "embed-multilingual-v3.0";
const DIM = Number(process.env.POA_EMBED_DIM || 1024);
const THRESHOLD = Number(process.env.POA_DEDUP_THRESHOLD || 0.85);
const DAYS = Number(process.env.POA_DEDUP_DAYS || 14);
const CACHE = "out/.veccache.json"; // candidate vectors handed from `dedup` to `embed` (saves a Cohere call)
const COHERE_BATCH = 96; // Cohere embed max texts per request

function log(...a) { console.error("[vec]", ...a); }
function softExit(msg) { log("WARN:", msg, "— skipping (feed unchanged)"); process.exit(0); }
function hardFail(msg) { log("ERROR:", msg); process.exit(1); }
function soft(e) { e.soft = true; return e; }

// --- text + math ----------------------------------------------------------

// Embed the canonical EN facts (title + summary). The multilingual model maps
// either language into the same space; EN is the source of truth, and using one
// language keeps the vector deterministic.
function embText(it) {
  return `${it.title_en || ""}\n${it.summary_en || ""}`.trim();
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// --- Cohere ---------------------------------------------------------------

// Both stored corpus and query candidates use inputType "search_document" so
// cosine is symmetric (near-duplicate detection, not asymmetric query→doc search).
async function embedTexts(texts) {
  const token = process.env.COHERE_API_KEY;
  if (!token) throw soft(new Error("COHERE_API_KEY not set"));
  let CohereClientV2;
  try { ({ CohereClientV2 } = require("cohere-ai")); }
  catch (e) { throw soft(new Error("cohere-ai not installed: " + e.message)); }
  const co = new CohereClientV2({ token });
  const out = [];
  for (let i = 0; i < texts.length; i += COHERE_BATCH) {
    const batch = texts.slice(i, i + COHERE_BATCH);
    let res;
    try {
      res = await co.embed({ texts: batch, model: MODEL, inputType: "search_document", embeddingTypes: ["float"] });
    } catch (e) { throw soft(new Error("Cohere embed failed: " + (e.message || e))); }
    const vecs = res && res.embeddings && res.embeddings.float;
    if (!Array.isArray(vecs) || vecs.length !== batch.length) throw soft(new Error("unexpected Cohere embed response"));
    out.push(...vecs);
  }
  return out;
}

// --- store ----------------------------------------------------------------

function openDb() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); }
  catch (e) { throw soft(new Error("cannot create state dir " + STATE_DIR + ": " + e.message)); }
  let Database, sqliteVec;
  try { Database = require("better-sqlite3"); sqliteVec = require("sqlite-vec"); }
  catch (e) { throw soft(new Error("native deps missing (better-sqlite3/sqlite-vec): " + e.message)); }
  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    sqliteVec.load(db);
    db.exec(`
      create table if not exists items(
        rowid        integer primary key autoincrement,
        id           text unique not null,
        published_at text,
        indexed_at   text,
        title_en     text,
        source_url   text
      );
      create virtual table if not exists vec_items using vec0(embedding float[${DIM}] distance_metric=cosine);
    `);
  } catch (e) { throw soft(new Error("cannot open store " + DB_PATH + ": " + e.message)); }
  return db;
}

function upsert(db, item, vec) {
  const f32 = Float32Array.from(vec);
  const now = new Date().toISOString();
  const row = db.prepare("select rowid from items where id = ?").get(item.id);
  let rowid;
  if (row) {
    rowid = row.rowid;
    db.prepare("update items set published_at=?, indexed_at=?, title_en=?, source_url=? where rowid=?")
      .run(item.published_at || null, now, item.title_en || null, item.source_url || null, rowid);
    db.prepare("delete from vec_items where rowid = ?").run(BigInt(rowid));
  } else {
    const info = db.prepare("insert into items(id, published_at, indexed_at, title_en, source_url) values (?,?,?,?,?)")
      .run(item.id, item.published_at || null, now, item.title_en || null, item.source_url || null);
    rowid = info.lastInsertRowid;
  }
  db.prepare("insert into vec_items(rowid, embedding) values (?, ?)").run(BigInt(rowid), f32);
}

// KNN against the store, then keep neighbours within the date window. We look up
// metadata in a second query rather than joining inside the MATCH for robustness.
function nearest(db, vec, days, k = 20) {
  const f32 = Float32Array.from(vec);
  const knn = db.prepare("select rowid, distance from vec_items where embedding match ? and k = ?").all(f32, k);
  const cutoff = Date.now() - days * 86400 * 1000;
  const getMeta = db.prepare("select id, published_at, title_en from items where rowid = ?");
  const out = [];
  for (const r of knn) {
    const m = getMeta.get(r.rowid);
    if (!m) continue;
    if (m.published_at && Date.parse(m.published_at) < cutoff) continue;
    out.push({ id: m.id, title_en: m.title_en, sim: 1 - r.distance });
  }
  return out.sort((a, b) => b.sim - a.sim);
}

// --- commands -------------------------------------------------------------

function readItems(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { hardFail("cannot read/parse " + file + ": " + e.message); }
  if (!data || !Array.isArray(data.items)) hardFail("no items[] array in " + file);
  return data;
}

async function cmdDedup(file) {
  const data = readItems(file);
  const items = data.items;
  if (items.length === 0) { log("dedup: 0 candidates, nothing to do"); return; }

  let db, vecs;
  try { db = openDb(); vecs = await embedTexts(items.map(embText)); }
  catch (e) { if (db) db.close(); if (e.soft) softExit("dedup: " + e.message); throw e; }

  const kept = [], dropped = [], cache = {};
  items.forEach((it, i) => {
    cache[it.id] = vecs[i];
    // today's ids are date-prefixed so they can't already be in the store, but
    // guard against self-match in case a prior run already embedded this id.
    const top = nearest(db, vecs[i], DAYS).filter(n => n.id !== it.id)[0];
    if (top && top.sim >= THRESHOLD) {
      dropped.push({ id: it.id, title_en: it.title_en, matched_id: top.id, matched_title_en: top.title_en, sim: Number(top.sim.toFixed(4)) });
    } else {
      kept.push(it);
    }
  });
  db.close();

  // hand survivors' vectors to the post-publish `embed` step (avoids re-calling Cohere)
  try { fs.mkdirSync("out", { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch (_) {}

  data.items = kept;
  data.source_count = kept.length; // keep source_count == items.length so validate.js still passes
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

  // observability + Phase 2 seed
  try {
    fs.writeFileSync("out/dedup-report.json",
      JSON.stringify({ generated_at: new Date().toISOString(), threshold: THRESHOLD, days: DAYS, kept: kept.length, dropped }, null, 2) + "\n");
  } catch (_) {}

  // enrich the run log (run.sh's token-merge preserves existing fields). Also
  // correct `published` to the post-dedup count — the agent wrote its pre-dedup
  // number, but cross-run dedup is the final gate, and run.sh's daily-usage
  // history reads this field (crossrun_dropped + published == the agent's count).
  try {
    const cyc = JSON.parse(fs.readFileSync("out/cycle.json", "utf8"));
    cyc.after_crossrun_dedup = kept.length;
    cyc.crossrun_dropped = dropped.length;
    cyc.published = kept.length;
    fs.writeFileSync("out/cycle.json", JSON.stringify(cyc, null, 2) + "\n");
  } catch (_) {}

  log(`dedup: kept ${kept.length}, dropped ${dropped.length} cross-run dup(s)`
    + (dropped.length ? ": " + dropped.map(d => `${d.id}~${d.matched_id}(${d.sim})`).join(", ") : ""));
}

async function cmdEmbed(file) {
  const data = readItems(file);
  const items = data.items;
  if (items.length === 0) { log("embed: 0 items"); return; }

  let db;
  try { db = openDb(); } catch (e) { if (e.soft) softExit("embed: " + e.message); throw e; }

  // reuse vectors computed by `dedup` this run; embed only what's missing
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch (_) {}
  const need = items.filter(it => !cache[it.id]);
  if (need.length) {
    let vecs;
    try { vecs = await embedTexts(need.map(embText)); }
    catch (e) { db.close(); if (e.soft) softExit("embed: " + e.message); throw e; }
    need.forEach((it, i) => { cache[it.id] = vecs[i]; });
  }

  db.transaction(() => { for (const it of items) upsert(db, it, cache[it.id]); })();
  const total = db.prepare("select count(*) c from items").get().c;
  db.close();
  log(`embed: upserted ${items.length} item(s); store now holds ${total}`);
}

async function cmdReindex(dir) {
  dir = dir || path.join(process.env.POA_PUBLISH_DIR || "/var/www/poa", "archive");
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort(); }
  catch (e) { hardFail("cannot read archive dir " + dir + ": " + e.message); }
  if (!files.length) hardFail("no .json files in " + dir);

  // de-dup by id across all archive files; later (newer) files win
  const byId = new Map();
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const it of (d.items || [])) byId.set(it.id, it);
    } catch (e) { log("WARN: skipping", f + ":", e.message); }
  }
  const items = [...byId.values()];
  log(`reindex: ${files.length} archive file(s) → ${items.length} unique item(s)`);

  let db;
  try { db = openDb(); } catch (e) { if (e.soft) softExit("reindex: " + e.message); throw e; }
  let done = 0;
  for (let i = 0; i < items.length; i += COHERE_BATCH) {
    const batch = items.slice(i, i + COHERE_BATCH);
    let vecs;
    try { vecs = await embedTexts(batch.map(embText)); }
    catch (e) { db.close(); if (e.soft) softExit("reindex: " + e.message); throw e; }
    db.transaction(() => { batch.forEach((it, j) => upsert(db, it, vecs[j])); })();
    done += batch.length;
    log(`reindex: ${done}/${items.length}`);
  }
  const total = db.prepare("select count(*) c from items").get().c;
  db.close();
  log(`reindex done; store now holds ${total}`);
}

async function cmdEval(file) {
  let labels;
  try { labels = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { hardFail("cannot read/parse " + file + ": " + e.message); }
  const pairs = Array.isArray(labels) ? labels : labels && labels.pairs;
  if (!Array.isArray(pairs) || !pairs.length) hardFail("no labeled pairs in " + file + " (expect [{a,b,duplicate}] or {pairs:[...]})");

  // embed each distinct text once
  const texts = [], idx = new Map();
  const key = t => { if (!idx.has(t)) { idx.set(t, texts.length); texts.push(t); } return idx.get(t); };
  const rows = pairs.map(p => ({ a: key(p.a), b: key(p.b), dup: !!p.duplicate }));
  let vecs;
  try { vecs = await embedTexts(texts); }
  catch (e) { if (e.soft) softExit("eval: " + e.message); throw e; }
  const sims = rows.map(r => ({ sim: cosine(vecs[r.a], vecs[r.b]), dup: r.dup }));
  const nDup = sims.filter(s => s.dup).length;

  log(`eval: ${pairs.length} pairs (${nDup} dup / ${pairs.length - nDup} non-dup)`);
  console.log("thresh  prec  recall  f1     (tp fp fn)");
  let best = { f1: -1 };
  for (let t = 0.70; t <= 0.951; t += 0.02) {
    let tp = 0, fp = 0, fn = 0;
    for (const s of sims) {
      const pred = s.sim >= t;
      if (pred && s.dup) tp++; else if (pred && !s.dup) fp++; else if (!pred && s.dup) fn++;
    }
    const prec = tp + fp ? tp / (tp + fp) : 1;
    const rec = tp + fn ? tp / (tp + fn) : 1;
    const f1 = prec + rec ? 2 * prec * rec / (prec + rec) : 0;
    console.log(`${t.toFixed(2)}    ${prec.toFixed(2)}  ${rec.toFixed(2)}    ${f1.toFixed(2)}   (${tp} ${fp} ${fn})`);
    if (f1 > best.f1) best = { t: Number(t.toFixed(2)), prec, rec, f1 };
  }
  log(`recommended POA_DEDUP_THRESHOLD=${best.t} (F1=${best.f1.toFixed(2)}, P=${best.prec.toFixed(2)}, R=${best.rec.toFixed(2)})`);
  log("note: prefer a slightly higher threshold than F1-optimal to favour precision (don't suppress genuine follow-up news).");
}

// --- dispatch -------------------------------------------------------------

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  const cmds = { dedup: cmdDedup, embed: cmdEmbed, reindex: cmdReindex, eval: cmdEval };
  if (!cmds[cmd]) {
    console.error("usage: vec.js dedup <items.json> | embed <items.json> | reindex [archiveDir] | eval <labels.json>");
    process.exit(2);
  }
  const defaults = { dedup: "out/items.json", embed: "out/items.json", reindex: undefined, eval: "eval/dedup-labels.sample.json" };
  try { await cmds[cmd](arg !== undefined ? arg : defaults[cmd]); }
  catch (e) { console.error("[vec] FATAL:", e.stack || e.message); process.exit(1); }
})();
