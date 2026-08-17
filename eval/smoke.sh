#!/usr/bin/env bash
#
# eval/smoke.sh — exercise run.sh end to end with a fake `codex` on PATH.
#
# Covers the two things that broke in production: the token/usage parse (silently
# wrong numbers) and the failure path (a dead agent must leave the published feed
# alone AND say so in the log — a 403 outage once produced a log that stopped at
# "generator: starting"). Run it after any change to the generator CLI or its flags.
#
#   npm run smoke
#
# Note: run.sh works in ./out and takes the poa-feed lock, so don't run this while
# a real run is in flight — it would clobber that run's out/ dir.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/pub" "$TMP/state"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# Fake generator: writes the two out/ files the real agent would, then emits the
# JSONL event stream run.sh parses. FAKE_CODEX_FAIL=1 dies the way a 401 does.
cat > "$TMP/bin/codex" <<'FAKE'
#!/usr/bin/env bash
set -eu
cat > /dev/null   # drain the prompt on stdin
if [ "${FAKE_CODEX_FAIL:-0}" = "1" ]; then
  echo 'ERROR codex_api: failed to connect: HTTP error: 401 Unauthorized' >&2
  exit 1
fi
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.env.SAMPLE, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  d.items = d.items.slice(0, 3).map((it, i) => ({
    ...it, id: today + "-smoke-item-" + i,
    published_at: new Date(Date.now() - 3600e3).toISOString(),
  }));
  d.source_count = d.items.length;
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/items.json", JSON.stringify(d, null, 2) + "\n");
  fs.writeFileSync("out/cycle.json", JSON.stringify({ raw_seen: 30, published: 3 }) + "\n");
'
echo '{"type":"thread.started","thread_id":"smoke"}'
echo 'Reading additional input from stdin...'   # non-JSON noise the parser must skip
echo '{"type":"turn.completed","usage":{"input_tokens":612345,"cached_input_tokens":400000,"output_tokens":8765,"reasoning_output_tokens":1200}}'
FAKE
chmod +x "$TMP/bin/codex"

export SAMPLE="$REPO/sample-items.json"
export PATH="$TMP/bin:$PATH"
export POA_SKIP_PULL=1 POA_PUBLISH_DIR="$TMP/pub" POA_STATE_DIR="$TMP/state"
# A stale claude-* pin must be ignored, not passed to codex as an unknown model.
export POA_MODEL=claude-sonnet-4-6

"$REPO/run.sh" > "$TMP/ok.log" 2>&1 || fail "good run exited non-zero: $(cat "$TMP/ok.log")"
grep -q "default model" "$TMP/ok.log" || fail "stale claude-* POA_MODEL was not ignored"

# cached_input_tokens is a SUBSET of input_tokens — adding it would double-count.
CYCLE="$TMP/pub/cycle.json" node -e '
  const c = JSON.parse(require("fs").readFileSync(process.env.CYCLE, "utf8"));
  if (c.tokens_used !== 612345 + 8765) throw new Error("tokens_used = " + c.tokens_used);
  if (c.cost_usd !== null) throw new Error("cost_usd should be null on a flat plan");
  if (!(c.duration_ms >= 0)) throw new Error("duration_ms = " + c.duration_ms);
' || fail "cycle.json usage merge is wrong"

BEFORE="$(shasum "$TMP/pub/items.json")"
FAKE_CODEX_FAIL=1 "$REPO/run.sh" > "$TMP/bad.log" 2>&1 && fail "dead agent should exit non-zero"
[ "$BEFORE" = "$(shasum "$TMP/pub/items.json")" ] || fail "failed run clobbered the published feed"
grep -q "codex run failed" "$TMP/bad.log" || fail "failure not logged (stderr is being swallowed)"
grep -q "401 Unauthorized" "$TMP/bad.log" || fail "agent's own error not surfaced in the log"

echo "SMOKE OK — usage merge, stale-model guard, and the failure path all hold"
