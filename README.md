# Previously on AI

A scheduled agent that reads the AI/developer ecosystem every morning and
publishes a small, deduplicated, **bilingual (EN/KO)** briefing as static JSON.
It runs unattended on a VPS, costs a few cents a day, and its output is rendered
by the live `/lab` page on [sungjukim.com](https://sungjukim.com/lab).

This repo is the **agent operations** side: the prompt, the runner, validation,
and the systemd units. The UI lives in the portfolio site and consumes the JSON
over a fixed schema — the two are decoupled by contract.

## How it works

```
07:00 KST (systemd timer)
  └─ run.sh
       ├─ git pull --ff-only            self-update from this repo
       ├─ claude -p < prompt.md         collect → filter → in-run dedup → write out/items.json + out/cycle.json
       ├─ vec.js dedup out/items.json   cross-RUN dedup: drop items matching the last ~14d (Cohere + sqlite-vec)
       ├─ validate.js out/items.json    schema + canonical tags + count check
       ├─ merge real tokens/cost        from the CLI usage report → cycle.json
       ├─ atomic publish                → /var/www/poa/{items.json,cycle.json,archive/}
       │                                  served by Caddy at https://sungjukim.com/data/
       └─ vec.js embed out/items.json   embed the published items into the store for tomorrow
```

- **The live feed never lives in git.** The agent writes to `./out/` (gitignored)
  and `run.sh` publishes to a served directory on the server. Only this code and a
  small `sample-items.json` (for local UI dev) are versioned.
- **A bad run can't empty the site.** Nothing is published unless validation passes;
  the previous feed stays up.
- **Korean is editorial, not translated.** `*_ko` fields are localized for Korean
  software engineers under explicit style rules (see `prompt.md`) — concise,
  no marketing tone, technical terms kept in English where natural.

## Cross-run dedup (vector store)

The generator only sees today's fetched stories, so it can merge same-run
duplicates but not a story that trickles across several days. `vec.js` adds that
memory with a small RAG loop — **embed → vector store → kNN retrieval → drop**:

- Every published item's `title_en + summary_en` is embedded with **Cohere Embed
  multilingual** and stored in a single-file **sqlite-vec** DB.
- Each run, the day's candidates are embedded and matched against the last
  `POA_DEDUP_DAYS` (default 14) of the store; anything at/above
  `POA_DEDUP_THRESHOLD` cosine similarity (default 0.85, tuned for Cohere v3 and
  leaning toward precision so genuine multi-day follow-ups aren't suppressed) is dropped before
  validation. Drops are recorded in `out/dedup-report.json`.
- **The store is server-side data**, not git: it lives at `$POA_STATE_DIR/poa.db`
  (default `/var/lib/poa`), is gitignored locally under `.state/`, and is fully
  rebuildable from `archive/*.json` via `node vec.js reindex`.
- **It can't empty the site.** If Cohere or the store is unavailable, dedup/embed
  warn and skip without touching the feed — the run still validates and publishes,
  just without that day's cross-run dedup.

Tune the threshold against a labeled set: `node vec.js eval eval/dedup-labels.sample.json`
prints precision / recall / F1 across thresholds and recommends one (favour
precision so genuine follow-up news isn't suppressed).

## Files

| File | Purpose |
|---|---|
| `prompt.md` | The full generation prompt (sources, schema, EN/KO rules, cycle log). |
| `run.sh` | Runner: self-update → generate → dedup → validate → publish (atomic) → embed. |
| `vec.js` | Vector store CLI: `dedup` / `embed` / `reindex` / `eval` (Cohere + sqlite-vec). |
| `validate.js` | Standalone schema/tag/count validator (exit non-zero on any problem). |
| `sample-items.json` | Example feed (schema v2) for local UI development. Not live data. |
| `eval/` | Labeled pairs + `vec.js eval` for tuning the dedup threshold. |
| `deploy/` | systemd `service` + `timer` and the VPS install guide. |

## Schema (v2)

Top level: `generated_at`, `source_count`, `schema_version: 2`, `items[]`.
Each item carries bilingual `title_*`, `summary_*`, `why_*`, `who_*`, `try_*`
(`_en` / `_ko`), plus `source`, `source_url`, `published_at`, `category`,
`score` (0–100), `relevance_score`, and `tags` from a fixed keyword set. See
`prompt.md` for the authoritative field list and `sample-items.json` for a
concrete example.

## Run locally

```bash
npm install                                           # cohere-ai, better-sqlite3, sqlite-vec
claude auth login                                     # subscription session (or: export ANTHROPIC_API_KEY=sk-ant-...)
echo 'COHERE_API_KEY=...' > .env                      # for the dedup embeddings (gitignored)

# publish into ./out and keep the vector store under ./.state instead of /var/lib/poa
POA_PUBLISH_DIR="$PWD/out" POA_STATE_DIR="$PWD/.state" POA_SKIP_PULL=1 ./run.sh
```

Seed the store once from existing history before the first deduped run:
`POA_STATE_DIR="$PWD/.state" node vec.js reindex <dir-with-archive-json>`.

Deploy to a server: see [`deploy/README.md`](deploy/README.md).
