# Deploying the generator on the VPS

The generator runs on the same Hetzner VPS that serves the portfolio. It writes
the live feed to `/var/www/poa/`, which Caddy serves at `/data/` on the apex —
**outside** the portfolio's `dist/`, so the site's CI (`rsync --delete dist/`)
never touches it. The live data is never committed to git.

```
/opt/previously-on-ai/     # this repo, cloned (git pull self-updates each run)
/var/www/poa/              # published feed (items.json, cycle.json, archive/) — served at /data/
/var/lib/poa/              # vector-dedup store (poa.db) — server-side data, rebuildable from archive/
/etc/poa/env               # COHERE_API_KEY + knobs (root:poa 640) — not in git
```

## 1. Prerequisites (as root)

```bash
# Node.js (validation, JSON merge, vector store), w3m (the agent renders article
# pages to text with it — without w3m it falls back to a crude tag-strip), and
# the Codex CLI
apt-get install -y nodejs npm git build-essential w3m   # build-essential: native better-sqlite3
npm install -g @openai/codex      # provides `codex` on PATH

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
cd /opt/previously-on-ai && npm install --omit=dev      # cohere-ai, better-sqlite3, sqlite-vec
chown -R poa:poa /opt/previously-on-ai
chmod +x /opt/previously-on-ai/run.sh
```

`git pull` self-updates code each run, but **not** dependencies. After a push
that changes `package.json`, re-run `npm install --omit=dev` on the box.

### Vector-dedup store + Cohere key

```bash
# server-side data dir for poa.db (not git, not web-served)
mkdir -p /var/lib/poa && chown poa:poa /var/lib/poa

# COHERE_API_KEY for the dedup embeddings (root:poa 640). run.sh also reads a
# /opt/previously-on-ai/.env if you prefer; /etc/poa/env is used by the systemd unit.
install -m 640 -o root -g poa /dev/stdin /etc/poa/env <<'ENV'
COHERE_API_KEY=...
ENV

# seed the store from existing history so day-one dedup has something to match
sudo -u poa -H POA_STATE_DIR=/var/lib/poa node /opt/previously-on-ai/vec.js reindex /var/www/poa/archive
```

If Cohere or the store is ever unavailable, runs still publish — just without
that day's cross-run dedup. The store is fully rebuildable any time with the same
`vec.js reindex /var/www/poa/archive`.

## 4. Authenticate the agent (ChatGPT subscription, not an API key)

Log in once **as `poa`**; the session persists in `/home/poa/.codex` and auto-refreshes.
Cron runs as `poa` with `HOME=/home/poa`, so the scheduled run reuses this login.
A login under `root` does **not** count — auth lives per-user under `$CODEX_HOME`.

```bash
sudo -u poa -H codex login      # interactive: open the URL it prints, approve
sudo -u poa -H codex login status   # expect "Logged in using ChatGPT"
```

To use pay-as-you-go billing instead, put `OPENAI_API_KEY=...` in
`/opt/previously-on-ai/.env` and skip the login. To pin a model, set `POA_MODEL`
in the crontab below (default is the CLI's default model).

> This replaced a Claude Code subscription run that started failing with
> `oauth_org_not_allowed` (HTTP 403, "organization has disabled Claude
> subscription access for Claude Code"). If codex ever fails the same way, the
> run now exits non-zero and the healthcheck in §7 alerts — it does not go quiet.

## 5. Schedule it (cron, 07:00 KST daily)

Install `poa`'s crontab (as root); cron runs as `poa` with `HOME=/home/poa`, so it
reuses the login session.

> ⚠️ Debian/Ubuntu's cron **ignores `CRON_TZ`** — `0 7 * * *` would run at 07:00 in
> the host timezone (UTC), not KST. Schedule in the host's timezone instead. On a
> UTC host, **07:00 KST = 22:00 UTC** (Korea has no DST):

```bash
crontab -u poa - <<'CRON'
PATH=/usr/local/bin:/usr/bin:/bin:/home/poa/.local/bin
POA_STATE_DIR=/var/lib/poa
# 07:00 KST = 22:00 UTC (Korea has no DST) — regenerate and publish the feed
0 22 * * * /opt/previously-on-ai/run.sh >> /home/poa/poa-feed.log 2>&1
CRON
crontab -u poa -l        # confirm
```

> cron does not read `/etc/poa/env`. For the cron path, put `COHERE_API_KEY` in
> `/opt/previously-on-ai/.env` (owned `poa`, `chmod 600`) — `run.sh` sources it,
> and it works for the systemd unit too. `.env` is gitignored, so `git pull`
> never touches it.

> Or set the box to Korean time once (`timedatectl set-timezone Asia/Seoul`) and use
> `0 7 * * *`. Alternative: the systemd timer (`deploy/poa-feed.{service,timer}`,
> `cp` to `/etc/systemd/system/` then `systemctl enable --now poa-feed.timer`) — its
> `OnCalendar=… Asia/Seoul` **does** honor the timezone.

## 6. Test a run now (don't wait for 07:00)

```bash
sudo -u poa -H /opt/previously-on-ai/run.sh     # runs once
cat /var/www/poa/cycle.json                     # real token usage (cost_usd is null on a flat plan)
curl -s https://sungjukim.com/data/items.json | jq '.items | length'
```

## 7. Operations: alerting & backup (recommended for unattended use)

A failed run keeps the previous feed up **silently** — so add a dead-man's-switch
and an off-server backup. Both are no-ops until set in `/opt/previously-on-ai/.env`.
`run.sh` is also self-locking (`flock`), so an overlapping manual + cron run can't
clobber each other — no crontab change needed.

**Alerting** — point `POA_HEALTHCHECK_URL` at a dead-man's-switch (e.g. the free
[healthchecks.io](https://healthchecks.io): create a check with period ~1 day +
grace). `run.sh` pings it on success and `"$URL/fail"` on failure, so both a
*failed* and a *never-started* run alert you.

```bash
echo 'POA_HEALTHCHECK_URL=https://hc-ping.com/<your-uuid>' >> /opt/previously-on-ai/.env
```

**Off-server backup** — the `archive/` is the durable source the vector store
rebuilds from; a VPS disk loss otherwise takes the whole history. Back it up with
rclone (any S3/R2/B2/GDrive target):

```bash
apt-get install -y rclone
sudo -u poa -H rclone config            # set up a remote (uses /home/poa/.config/rclone)
echo 'POA_BACKUP_REMOTE=<remote>:<bucket>' >> /opt/previously-on-ai/.env
sudo -u poa -H rclone copy /var/www/poa/archive '<remote>:<bucket>/archive'   # seed once
```

Thereafter each run does an incremental `rclone copy` (never deletes remote-side).

## Notes
- `run.sh` does `git pull --ff-only` first, so pushing to this repo updates the
  next scheduled run — no separate deploy step. (A broken push can't empty the
  site: validation must pass before anything is published.)
- `git pull` updates code only, not deps — re-run `npm install --omit=dev` after a
  push that changes `package.json`.
- Cost: one `codex exec` run per day, ~600k tokens against the ChatGPT plan's
  quota (no per-run charge). Pin a cheaper model with `POA_MODEL` if it bites.
- Caddy route that exposes this dir lives in the portfolio repo
  (`deploy/Caddyfile`, the `handle /data/*` block on the apex).
