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

## 4. Authenticate the agent (Claude subscription, not an API key)

Log in once as `poa`; the session persists in `/home/poa/.claude` and auto-refreshes.
Cron runs as `poa` with `HOME=/home/poa`, so the scheduled run reuses this login.

```bash
sudo -u poa -H claude auth login --claudeai   # interactive: open the URL, paste the code
sudo -u poa -H claude auth status             # verify
```

Do **not** set `ANTHROPIC_API_KEY` anywhere for this user — it would override the
subscription session. No env file is needed; to pin a model, set `POA_MODEL` in
the crontab below (default is the CLI's default model).

## 5. Schedule it (cron, 07:00 KST daily)

Install `poa`'s crontab (as root); cron runs as `poa` with `HOME=/home/poa`, so it
reuses the login session.

> ⚠️ Debian/Ubuntu's cron **ignores `CRON_TZ`** — `0 7 * * *` would run at 07:00 in
> the host timezone (UTC), not KST. Schedule in the host's timezone instead. On a
> UTC host, **07:00 KST = 22:00 UTC** (Korea has no DST):

```bash
crontab -u poa - <<'CRON'
PATH=/usr/local/bin:/usr/bin:/bin:/home/poa/.local/bin
POA_MODEL=claude-sonnet-4-6
# 07:00 KST = 22:00 UTC (Korea has no DST) — regenerate and publish the feed
0 22 * * * /opt/previously-on-ai/run.sh >> /home/poa/poa-feed.log 2>&1
CRON
crontab -u poa -l        # confirm
```

> Or set the box to Korean time once (`timedatectl set-timezone Asia/Seoul`) and use
> `0 7 * * *`. Alternative: the systemd timer (`deploy/poa-feed.{service,timer}`,
> `cp` to `/etc/systemd/system/` then `systemctl enable --now poa-feed.timer`) — its
> `OnCalendar=… Asia/Seoul` **does** honor the timezone.

## 6. Test a run now (don't wait for 07:00)

```bash
sudo -u poa -H /opt/previously-on-ai/run.sh     # runs once
cat /var/www/poa/cycle.json                     # real tokens + cost
curl -s https://sungjukim.com/data/items.json | jq '.items | length'
```

## Notes
- `run.sh` does `git pull --ff-only` first, so pushing to this repo updates the
  next scheduled run — no separate deploy step. (A broken push can't empty the
  site: validation must pass before anything is published.)
- Cost: one `claude -p` run per day. Pin a cheaper model with `POA_MODEL` if needed.
- Caddy route that exposes this dir lives in the portfolio repo
  (`deploy/Caddyfile`, the `handle /data/*` block on the apex).
