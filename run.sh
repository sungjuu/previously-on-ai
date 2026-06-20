#!/usr/bin/env bash
#
# run.sh — regenerate the "Previously on AI" feed and publish it.
#
# Pipeline: self-update (git pull) → run the Claude Code CLI headless with
# prompt.md → validate out/items.json → merge real token/cost into cycle.json →
# atomically publish items.json + cycle.json to the served data dir.
#
# The live data never lives in git: the agent writes to ./out/, and this script
# publishes to $POA_PUBLISH_DIR (default /var/www/poa, served by Caddy at /data/).
# A bad run never empties the site — we publish only after validation passes.
#
# Requirements: Claude Code CLI on PATH (`claude`), authenticated — either a
# logged-in subscription session (`claude auth login`) or ANTHROPIC_API_KEY.
# Node.js (for validation + JSON merge).
#
# Env knobs:
#   POA_PUBLISH_DIR   where to publish (default /var/www/poa)
#   POA_MODEL         pin a model, e.g. claude-sonnet-4-6 (default: CLI default)
#   POA_SKIP_PULL=1   skip the self-update git pull
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PUBLISH_DIR="${POA_PUBLISH_DIR:-/var/www/poa}"
MODEL="${POA_MODEL:-}"
PROMPT_FILE="prompt.md"

ts() { date "+%Y-%m-%d %H:%M:%S %Z"; }
log() { echo "[$(ts)] $*"; }

# 1. self-update from the public repo (a push auto-updates the next run)
if [ "${POA_SKIP_PULL:-0}" != "1" ] && git rev-parse --git-dir >/dev/null 2>&1; then
  git pull --ff-only --quiet 2>/dev/null && log "code: up to date with origin" \
    || log "code: git pull skipped/failed, using current checkout"
fi

# 2. clean run dir
rm -rf out && mkdir -p out

# 3. run the generator headless; capture the CLI usage JSON for real cost/tokens
CLAUDE_ARGS=(--print --output-format json --dangerously-skip-permissions)
[ -n "$MODEL" ] && CLAUDE_ARGS+=(--model "$MODEL")
log "generator: starting ($([ -n "$MODEL" ] && echo "$MODEL" || echo "default model"))"
if ! claude "${CLAUDE_ARGS[@]}" < "$PROMPT_FILE" > out/_clirun.json; then
  log "generator: claude run failed — not publishing" >&2
  exit 1
fi

# 4. validate the feed the agent wrote
ITEMS=out/items.json
if [ ! -f "$ITEMS" ] || ! node "$SCRIPT_DIR/validate.js" "$ITEMS"; then
  log "VALIDATION FAILED — keeping previously published feed" >&2
  exit 1
fi

# 5. merge real token/cost from the CLI usage report into cycle.json
node -e '
  const fs = require("fs");
  const cli = JSON.parse(fs.readFileSync("out/_clirun.json", "utf8"));
  const u = cli.usage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0)
               + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  let cyc = {};
  try { cyc = JSON.parse(fs.readFileSync("out/cycle.json", "utf8")); } catch (_) {}
  cyc.generated_at = new Date().toISOString();
  cyc.tokens_used = tokens;
  cyc.cost_usd = typeof cli.total_cost_usd === "number" ? Number(cli.total_cost_usd.toFixed(4)) : null;
  cyc.duration_ms = cli.duration_ms ?? null;
  fs.writeFileSync("out/cycle.json", JSON.stringify(cyc, null, 2) + "\n");
  console.log(`[cycle] ${cyc.tokens_used} tokens · $${cyc.cost_usd}`);
' || log "cycle.json enrichment skipped"

# 6. atomic publish (write tmp on the same fs, then rename)
mkdir -p "$PUBLISH_DIR/archive"
install -m 644 "$ITEMS" "$PUBLISH_DIR/.items.json.tmp" && mv -f "$PUBLISH_DIR/.items.json.tmp" "$PUBLISH_DIR/items.json"
if [ -f out/cycle.json ]; then
  install -m 644 out/cycle.json "$PUBLISH_DIR/.cycle.json.tmp" && mv -f "$PUBLISH_DIR/.cycle.json.tmp" "$PUBLISH_DIR/cycle.json"
fi
cp -f "$PUBLISH_DIR/items.json" "$PUBLISH_DIR/archive/$(date +%F).json"

log "published $(node -p 'require("./out/items.json").items.length') items → $PUBLISH_DIR/items.json"
