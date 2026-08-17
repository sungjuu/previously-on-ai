#!/usr/bin/env bash
#
# run.sh — regenerate the "Previously on AI" feed and publish it.
#
# Pipeline: self-update (git pull) → run the Codex CLI headless with prompt.md →
# validate out/items.json → merge real token usage into cycle.json →
# atomically publish items.json + cycle.json to the served data dir.
#
# The live data never lives in git: the agent writes to ./out/, and this script
# publishes to $POA_PUBLISH_DIR (default /var/www/poa, served by Caddy at /data/).
# A bad run never empties the site — we publish only after validation passes.
#
# Requirements: Codex CLI on PATH (`codex`), authenticated as the user this runs
# as — either a logged-in ChatGPT session (`codex login`) or OPENAI_API_KEY.
# Node.js (for validation + JSON merge). w3m, for HTML→text article reads.
#
# Env knobs:
#   POA_PUBLISH_DIR   where to publish (default /var/www/poa)
#   POA_STATE_DIR     where the vector-dedup store lives (default /var/lib/poa)
#   POA_MODEL         pin a model, e.g. gpt-5-codex (default: CLI default)
#   POA_SKIP_PULL=1   skip the self-update git pull
#   POA_HEALTHCHECK_URL  dead-man's-switch ping URL (success / "$URL/fail") — alerts on failure
#   POA_BACKUP_REMOTE    rclone target for off-server archive backup (e.g. r2:poa-backup)
#
# Secrets (COHERE_API_KEY for the dedup embeddings) are read from ./.env if it
# exists. Cross-run dedup degrades gracefully: if Cohere/the store is
# unavailable, the run still validates and publishes — just without that day's
# cross-run dedup — so it can never empty the site.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load local secrets / overrides (COHERE_API_KEY, POA_STATE_DIR, ...) and export
# them to the node helpers. set -a auto-exports everything sourced here.
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; . "$SCRIPT_DIR/.env"; set +a; fi

PUBLISH_DIR="${POA_PUBLISH_DIR:-/var/www/poa}"
MODEL="${POA_MODEL:-}"
# POA_MODEL used to hold a claude-* id (set in poa's crontab). Ignore leftovers
# rather than passing an unknown model to codex and losing a day's run.
case "$MODEL" in claude-*) MODEL="" ;; esac
PROMPT_FILE="prompt.md"
ITEMS=out/items.json

ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }
log() { echo "[$(ts)] $*"; }

# Optional ops hooks — no-op unless set in .env:
#   POA_HEALTHCHECK_URL  ping this on success, "$URL/fail" on failure. Point it at a
#                        dead-man's-switch (e.g. healthchecks.io) so a failed OR a
#                        never-started run alerts you — the site fails silently otherwise.
#   POA_BACKUP_REMOTE    rclone target for off-server archive backup (e.g. r2:poa-backup).
ping_hc() {  # ping_hc [/fail]
  [ -n "${POA_HEALTHCHECK_URL:-}" ] && command -v curl >/dev/null 2>&1 || return 0
  curl -fsS -m 10 -o /dev/null "${POA_HEALTHCHECK_URL}${1:-}" 2>/dev/null \
    && log "healthcheck: pinged ${1:-(ok)}" || log "healthcheck: ping ${1:-(ok)} failed (non-fatal)"
}

# Single-flight: stop overlapping runs (cron + a manual run) from clobbering out/
# or publishing on top of each other. flock holds fd 9 until this process exits.
LOCK="${TMPDIR:-/tmp}/poa-feed.lock"
# Braces matter: `exec 9>"$LOCK" 2>/dev/null` would apply BOTH redirections to
# the shell permanently, sending every later `>&2` to /dev/null — which is how
# the 403 outage produced a log with "generator: starting" and nothing after it.
# Scoping the suppression to the group keeps fd 9 open and stderr intact.
{ exec 9>"$LOCK"; } 2>/dev/null || true
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  log "another run holds $LOCK — exiting"; exit 0
fi

# The CLI usage report goes OUTSIDE ./out — the agent may recreate ./out during
# its run, which would unlink a file we'd placed inside it. Keep it in /tmp.
CLIRUN="$(mktemp "${TMPDIR:-/tmp}/poa-clirun.XXXXXX")"
# On any non-zero exit, alert via the healthcheck /fail endpoint (if configured)
# so silent failures surface; always clean up the usage report.
on_exit() { local code=$?; rm -f "$CLIRUN"; [ "$code" -ne 0 ] && ping_hc /fail; return 0; }
trap on_exit EXIT

# 1. self-update from the public repo (a push auto-updates the next run)
if [ "${POA_SKIP_PULL:-0}" != "1" ] && git rev-parse --git-dir >/dev/null 2>&1; then
  git pull --ff-only --quiet 2>/dev/null && log "code: up to date with origin" \
    || log "code: git pull skipped/failed, using current checkout"
fi

# 2. clean run dir
rm -rf out && mkdir -p out

# 3. run the generator headless; capture the JSONL event stream for token usage.
#    workspace-write confines the agent's writes to this repo (it only needs
#    ./out/), and network_access lets it fetch the source feeds — no need for the
#    blanket "skip all approvals" escape hatch the old claude path used.
#    codex exits non-zero on auth/API failure (unlike `claude -p --output-format
#    json`, which exited 0 and wrapped errors as {"is_error":true} — that is how a
#    2-day auth outage stayed silent), so the exit code alone is a real guard.
CODEX_ARGS=(exec --json -s workspace-write
            -c sandbox_workspace_write.network_access=true
            -c tools.web_search=true)
[ -n "$MODEL" ] && CODEX_ARGS+=(-m "$MODEL")
log "generator: starting ($([ -n "$MODEL" ] && echo "$MODEL" || echo "default model"))"
START=$SECONDS
# stderr is merged in: codex writes progress and API errors there, and on failure
# the tail below is the only breadcrumb in the log. The parser skips non-JSON.
if ! codex "${CODEX_ARGS[@]}" - < "$PROMPT_FILE" > "$CLIRUN" 2>&1; then
  log "generator: codex run failed — not publishing" >&2
  tail -n 5 "$CLIRUN" >&2
  exit 1
fi

# 3a. hard recency cap: drop items whose published_at is older than
#     POA_MAX_AGE_DAYS (default 3). The prompt asks the agent for 24–48h
#     coverage, but older stories still slip through — this makes the limit
#     mechanical. Mutates out/items.json (removals only, keeps source_count
#     consistent). Soft-fails so it can never block an otherwise good run.
node -e '
  const fs = require("fs");
  const days = Number(process.env.POA_MAX_AGE_DAYS || 3);
  const cutoff = Date.now() - days * 86400e3;
  const d = JSON.parse(fs.readFileSync("out/items.json", "utf8"));
  const keep = [], dropped = [];
  for (const it of d.items || []) {
    const t = Date.parse(it.published_at);
    (Number.isNaN(t) || t >= cutoff ? keep : dropped).push(it); // unparseable dates are validate.js\x27s job
  }
  if (dropped.length) {
    d.items = keep;
    d.source_count = keep.length;
    fs.writeFileSync("out/items.json", JSON.stringify(d, null, 2) + "\n");
    console.log(`[age] dropped ${dropped.length} item(s) older than ${days}d: ` + dropped.map(i => i.id).join(", "));
  } else {
    console.log(`[age] all ${keep.length} item(s) within ${days}d`);
  }
' || log "age filter errored — continuing with the unfiltered feed"

# 3b. cross-run dedup: drop candidates that match a recent published item.
#     Mutates out/items.json (removals only, keeps source_count consistent) and
#     records out/dedup-report.json. Soft-fails (exit 0, feed untouched) if
#     Cohere/the store is unavailable; a hard JSON error is caught by validate next.
log "dedup: checking candidates against the last ${POA_DEDUP_DAYS:-14}d of the store"
node "$SCRIPT_DIR/vec.js" dedup "$ITEMS" || log "dedup: errored — continuing with the un-deduped feed"

# 4. validate the feed the agent wrote
if [ ! -f "$ITEMS" ] || ! node "$SCRIPT_DIR/validate.js" "$ITEMS"; then
  log "VALIDATION FAILED — keeping previously published feed" >&2
  exit 1
fi

# 5. merge real token usage from the codex event stream into cycle.json.
#    Usage rides on the last "turn.completed" event; cost is a flat subscription
#    with no per-run price, so cost_usd is null (the usage chart plots tokens).
CLIRUN="$CLIRUN" RUN_MS="$(( (SECONDS - START) * 1000 ))" node -e '
  const fs = require("fs");
  let u = {};
  for (const line of fs.readFileSync(process.env.CLIRUN, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;   // codex interleaves plain log lines
    try { const e = JSON.parse(line); if (e.type === "turn.completed" && e.usage) u = e.usage; } catch (_) {}
  }
  // cached_input_tokens and reasoning_output_tokens are subsets of
  // input_tokens / output_tokens — adding them would double-count.
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0);
  let cyc = {};
  try { cyc = JSON.parse(fs.readFileSync("out/cycle.json", "utf8")); } catch (_) {}
  cyc.generated_at = new Date().toISOString();
  cyc.tokens_used = tokens;
  cyc.cost_usd = null;
  cyc.duration_ms = Number(process.env.RUN_MS) || null;
  fs.writeFileSync("out/cycle.json", JSON.stringify(cyc, null, 2) + "\n");
  console.log(`[cycle] ${cyc.tokens_used} tokens · ${Math.round((cyc.duration_ms || 0) / 1000)}s`);
' || log "cycle.json enrichment skipped"

# 5b. stamp the REAL publish time into items.json. The agent writes a nominal
#     time (it tends to emit the scheduled 07:00 KST), so the runner overwrites
#     generated_at with the actual wall-clock time in KST (+09:00).
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync("out/items.json", "utf8"));
  d.generated_at = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19) + "+09:00";
  fs.writeFileSync("out/items.json", JSON.stringify(d, null, 2) + "\n");
  console.log("[items] generated_at = " + d.generated_at);
' || log "generated_at stamp skipped"

# 6. atomic publish (write tmp on the same fs, then rename)
mkdir -p "$PUBLISH_DIR/archive"
install -m 644 "$ITEMS" "$PUBLISH_DIR/.items.json.tmp" && mv -f "$PUBLISH_DIR/.items.json.tmp" "$PUBLISH_DIR/items.json"
if [ -f out/cycle.json ]; then
  install -m 644 out/cycle.json "$PUBLISH_DIR/.cycle.json.tmp" && mv -f "$PUBLISH_DIR/.cycle.json.tmp" "$PUBLISH_DIR/cycle.json"
fi
# Archive is named by the KST publication date — the server may run in UTC,
# where `date +%F` would be one day behind around the 07:00 KST run.
cp -f "$PUBLISH_DIR/items.json" "$PUBLISH_DIR/archive/$(TZ=Asia/Seoul date +%F).json"

# 6b. RSS mirror of the feed, served at /data/feed.xml. Soft-fails: RSS is a
#     convenience view, never a reason to fail an otherwise good run.
node "$SCRIPT_DIR/rss.js" "$ITEMS" "$PUBLISH_DIR/feed.xml" && chmod 644 "$PUBLISH_DIR/feed.xml" \
  || log "rss: feed.xml not updated (non-fatal)"

# 7. append this cycle to the rolling daily-usage history (one entry per date,
#    last 60 days) — served at /data/cycle-history.json for the lab usage chart.
if [ -f out/cycle.json ]; then
  HIST="$PUBLISH_DIR/cycle-history.json" node -e '
    const fs = require("fs");
    const hist = process.env.HIST;
    const c = JSON.parse(fs.readFileSync("out/cycle.json", "utf8"));
    // Chart dates are KST publication dates. cycle.generated_at is UTC, which
    // is still the previous day at 07:00 KST — shift +9h before taking the date.
    const base = c.generated_at ? Date.parse(c.generated_at) : Date.now();
    const date = new Date(base + 9 * 3600 * 1000).toISOString().slice(0, 10);
    let rows = [];
    try { const r = JSON.parse(fs.readFileSync(hist, "utf8")); if (Array.isArray(r)) rows = r; } catch (_) {}
    rows = rows.filter(r => r.date !== date);
    rows.push({ date, tokens_used: c.tokens_used ?? null, published: c.published ?? null, raw_seen: c.raw_seen ?? null, after_dedup: c.after_dedup ?? null, crossrun_dropped: c.crossrun_dropped ?? null });
    rows.sort((a, b) => a.date < b.date ? -1 : 1);
    rows = rows.slice(-60);
    fs.writeFileSync(hist + ".tmp", JSON.stringify(rows) + "\n");
    fs.renameSync(hist + ".tmp", hist);
    console.log("[history] " + rows.length + " day(s)");
  ' && chmod 644 "$PUBLISH_DIR/cycle-history.json" || log "history update skipped"
fi

# 8. embed the now-published items into the vector store so tomorrow's run can
#    dedup against them. Reuses vectors cached by the dedup step; soft-fails
#    (store simply isn't updated this run) if Cohere/the store is unavailable.
node "$SCRIPT_DIR/vec.js" embed "$ITEMS" || log "embed: store not updated this run"

# 9. off-server backup of the archive — the durable source the vector store is
#    rebuilt from (`vec.js reindex`). Without this, a VPS disk loss takes the
#    whole history with it. No-op unless POA_BACKUP_REMOTE + rclone are present.
#    `copy` only uploads new/changed files and never deletes remote-side.
if [ -n "${POA_BACKUP_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy --no-traverse "$PUBLISH_DIR/archive" "$POA_BACKUP_REMOTE/archive" >/dev/null 2>&1 \
      && log "backup: archive → $POA_BACKUP_REMOTE/archive" \
      || log "backup: rclone failed (non-fatal)"
  else
    log "backup: POA_BACKUP_REMOTE set but rclone not installed — skipped"
  fi
fi

log "published $(node -p 'require("./out/items.json").items.length') items → $PUBLISH_DIR/items.json"
ping_hc   # success heartbeat (dead-man's-switch); failures alert via on_exit trap
