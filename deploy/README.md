# Deploying the generator on the VPS

The generator runs on the same Hetzner VPS that serves the portfolio. It writes
the live feed to `/var/www/poa/`, which Caddy serves at `/data/` on the apex —
**outside** the portfolio's `dist/`, so the site's CI (`rsync --delete dist/`)
never touches it. The live data is never committed to git.

```
/opt/previously-on-ai/     # this repo, cloned (git pull self-updates each run)
/var/www/poa/              # published feed (items.json, cycle.json, archive/) — served at /data/
/etc/poa/env               # ANTHROPIC_API_KEY (root:poa 640) — not in git
```

## 1. Prerequisites (as root)

```bash
# Node.js (validation + JSON merge) and the Claude Code CLI
apt-get install -y nodejs npm git
npm install -g @anthropic-ai/claude-code      # provides `claude` on PATH

# dedicated unprivileged user
adduser --system --group --home /home/poa --shell /bin/bash poa
```

## 2. Published data dir (served by Caddy at /data/)

```bash
mkdir -p /var/www/poa/archive
chown -R poa:poa /var/www/poa
chmod 755 /var/www/poa            # world-readable so Caddy can serve it
# seed once so the page isn't empty before the first run (sample, not live):
install -m 644 -o poa -g poa /opt/previously-on-ai/sample-items.json /var/www/poa/items.json
```

## 3. Clone the repo

```bash
git clone https://github.com/sungjuu/previously-on-ai.git /opt/previously-on-ai
chown -R poa:poa /opt/previously-on-ai
chmod +x /opt/previously-on-ai/run.sh
```

## 4. API key (not in git)

```bash
mkdir -p /etc/poa
cat > /etc/poa/env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
# optional: POA_MODEL=claude-sonnet-4-6
EOF
chown root:poa /etc/poa/env
chmod 640 /etc/poa/env
```

## 5. systemd timer (07:00 KST daily)

```bash
cp deploy/poa-feed.service /etc/systemd/system/
cp deploy/poa-feed.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now poa-feed.timer
systemctl list-timers poa-feed.timer        # confirm next run
```

## 6. Test a run now (don't wait for 07:00)

```bash
systemctl start poa-feed.service            # runs once
journalctl -u poa-feed.service -n 50 --no-pager
cat /var/www/poa/cycle.json                 # real tokens + cost
curl -s https://sungjukim.com/data/items.json | jq '.items | length'
```

## Notes
- `run.sh` does `git pull --ff-only` first, so pushing to this repo updates the
  next scheduled run — no separate deploy step. (A broken push can't empty the
  site: validation must pass before anything is published.)
- Cost: one `claude -p` run per day. Pin a cheaper model with `POA_MODEL` if needed.
- Caddy route that exposes this dir lives in the portfolio repo
  (`deploy/Caddyfile`, the `handle /data/*` block on the apex).
