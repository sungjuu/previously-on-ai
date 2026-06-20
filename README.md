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
       ├─ claude -p < prompt.md         collect → filter → semantic dedup → write out/items.json + out/cycle.json
       ├─ validate.js out/items.json    schema + canonical tags + count check
       ├─ merge real tokens/cost        from the CLI usage report → cycle.json
       └─ atomic publish                → /var/www/poa/{items.json,cycle.json,archive/}
                                          served by Caddy at https://sungjukim.com/data/
```

- **The live feed never lives in git.** The agent writes to `./out/` (gitignored)
  and `run.sh` publishes to a served directory on the server. Only this code and a
  small `sample-items.json` (for local UI dev) are versioned.
- **A bad run can't empty the site.** Nothing is published unless validation passes;
  the previous feed stays up.
- **Korean is editorial, not translated.** `*_ko` fields are localized for Korean
  software engineers under explicit style rules (see `prompt.md`) — concise,
  no marketing tone, technical terms kept in English where natural.

## Files

| File | Purpose |
|---|---|
| `prompt.md` | The full generation prompt (sources, schema, EN/KO rules, cycle log). |
| `run.sh` | Runner: self-update → generate → validate → publish (atomic). |
| `validate.js` | Standalone schema/tag/count validator (exit non-zero on any problem). |
| `sample-items.json` | Example feed (schema v2) for local UI development. Not live data. |
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
claude auth login                                     # subscription session (or: export ANTHROPIC_API_KEY=sk-ant-...)
POA_PUBLISH_DIR="$PWD/out" POA_SKIP_PULL=1 ./run.sh   # publishes into ./out instead of /var/www/poa
```

Deploy to a server: see [`deploy/README.md`](deploy/README.md).
