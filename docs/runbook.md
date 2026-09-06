# Runbook - MICT-RAG-002 Production Operations

Written for a second person redeploying from scratch. Every command is copy-pasteable. Secrets live in `/opt/rag/deploy/.env.production`, which the systemd unit loads as its `EnvironmentFile`.

Runtime shape: one Node process (`tsx src/server.ts`) managed by the `docintel-rag` systemd unit, bound to `127.0.0.1:3002`, talking to host Postgres 18 with pgvector on the local socket. A host `cloudflared` connector exposes `/query` and `/health` at `https://docs.jakemorganlabs.dev`. There are no containers in the runtime path.

## Table of contents

1. [Redeploy](#1-redeploy)
2. [Migrate database](#2-migrate-database)
3. [Rotate HMAC secret](#3-rotate-hmac-secret)
4. [Restore from backup](#4-restore-from-backup)
5. [Re-ingest corpus](#5-re-ingest-corpus)
6. [Check DLQ](#6-check-dlq--dead-letter-queue)
7. [Backup and restore-test schedule](#7-backup-and-restore-test-schedule)
8. [Closeout protocol](#8-closeout-evidence-commit-protocol)
9. [Release notes template](#9-release-notes-template)

## 1. Redeploy

Pull latest code, install pinned dependencies, restart the service, probe health:

```bash
cd /opt/rag
git pull origin main
npm ci
sudo systemctl restart docintel-rag
curl -sf http://127.0.0.1:3002/health | jq .
```

First-time host setup (unit file at `/etc/systemd/system/docintel-rag.service`):

```ini
[Unit]
Description=Document Intelligence RAG (MICT-RAG-002)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=jake
Group=jake
WorkingDirectory=/opt/rag
EnvironmentFile=/opt/rag/deploy/.env.production
ExecStart=/opt/rag/scripts/start-server.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docintel-rag

[Install]
WantedBy=multi-user.target
```

```bash
cp deploy/.env.production.example deploy/.env.production   # fill every __REPLACE_ME__
sudo systemctl daemon-reload
sudo systemctl enable --now docintel-rag
journalctl -u docintel-rag -f
```

## 2. Migrate database

Apply pending migrations. Safe to re-run:

```bash
cd /opt/rag && set -a && . deploy/.env.production && set +a
npx tsx scripts/migrate.ts
```

Fresh rebuild drops everything. Confirm first:

```bash
npx tsx scripts/migrate-fresh.ts
```

## 3. Rotate HMAC secret

Run this once during setup, not first during an incident.

1. Generate a new secret:
   ```bash
   openssl rand -hex 32
   ```
2. Set it in `/opt/rag/deploy/.env.production`:
   ```
   HMAC_SECRET=<new-secret>
   ```
3. Restart the service so it reads the new secret at startup:
   ```bash
   sudo systemctl restart docintel-rag
   ```
4. Confirm old clients fail:
   ```bash
   bash scripts/smoke_prod.sh
   ```
5. Hand the new secret to clients with a rotation deadline.
6. Confirm updated clients succeed.

## 4. Restore from backup

Nightly dumps live at `/var/backups/pgvector/rag_YYYY-MM-DD.dump` (custom format, 7-day rotation).

Pick the newest dump by modification time. The `printf` form returns an empty string when nothing matches instead of falling through to a random file:

```bash
NEWEST=$(find /var/backups/pgvector -maxdepth 1 -name 'rag_*.dump' -type f -printf '%T@ %p\n' | sort -rn | head -n 1 | cut -d' ' -f2-)
test -n "$NEWEST" && pg_restore --list "$NEWEST" >/dev/null && echo "restoring $NEWEST"
```

Restore into the live database (destroys current rows in the affected tables):

```bash
sudo systemctl stop docintel-rag
sudo -u postgres pg_restore --clean --if-exists --no-owner -d docintel "$NEWEST"
sudo systemctl start docintel-rag
curl -sf http://127.0.0.1:3002/health | jq .
```

Prove the vectors survived with the scratch-container restore test (does not touch the live database):

```bash
bash deploy/restore.sh
```

## 5. Re-ingest corpus

Drop PDFs into `/opt/rag/corpus/`, then:

```bash
cd /opt/rag && set -a && . deploy/.env.production && set +a
bash deploy/reingest.sh
```

If `reingest.sh` exits non-zero with "zero files ingested", the service user cannot read the files. Fix ownership and retry:

```bash
chmod -R a+r ./corpus/
bash deploy/reingest.sh
```

## 6. Check DLQ (dead-letter queue)

```bash
sudo -u postgres psql -d docintel -c "
  SELECT created_at, stage, error_code, error, item_snapshot
  FROM dead_letters
  ORDER BY created_at DESC
  LIMIT 20;
"
```

## 7. Backup and restore-test schedule

Two cron jobs. The nightly one proves a dump was written. The weekly one proves the newest dump restores and still answers an ANN query. A backup that has never been restored is not a backup.

| Job | Script | Schedule | Output |
|---|---|---|---|
| Nightly dump | `deploy/cron/pg_dump.sh` | `05 2 * * *` | `/var/backups/pgvector/rag_YYYY-MM-DD.dump`, 7-day rotation |
| Weekly restore test | `deploy/cron/restore_test.sh` | `30 3 * * 0` | `restore_test_YYYY-MM-DD.log` plus one line in `restore_test_status.log` |

`pg_dump.sh` needs `sudo -u postgres`, so it runs from root's crontab. `restore_test.sh` needs docker (it restores into a throwaway `pgvector/pgvector:pg18` container on port 15432) and runs from the deploy user's crontab:

```bash
crontab -e
# add:
30 3 * * 0  /opt/rag/deploy/cron/restore_test.sh
```

Logs go to `/var/log/docintel/` when writable, otherwise `~/backups/rag/`. Set `SLACK_WEBHOOK_URL` in the cron environment to get a message on failure. Check the rolling status file before trusting a backup:

```bash
tail -n 5 ~/backups/rag/restore_test_status.log
```

## 8. Closeout evidence commit protocol

After deploy and evidence capture:

```bash
git checkout -b closeout-evidence
# drop evidence files into docs/evidence/:
#   eval_report_prod.md
#   smoke_prod_output.txt
#   restore_test.txt
bash scripts/secret_gate.sh          # evidence is the likeliest place a URL/token slips in
git add docs/evidence README.md && git commit -m "closeout: production evidence - prod evals green, HMAC enforcement proof, restore tested"
git push -u origin closeout-evidence # merge, then tag if not already tagged
```

Repo is reviewer-complete only after this commit lands.

## 9. Release notes template

Every release carries a non-blank note in this shape:

```markdown
## Highlights
- (3 bullets: what changed, why it matters)
-

## Evidence
- [eval report](docs/evidence/eval_report_*.md)
- [smoke test](docs/evidence/smoke_prod_output.txt)
- [restore test](docs/evidence/restore_test.txt)

## Docs
- [SRS/TDD](docs/SRS-TDD.md)
- [Runbook](docs/runbook.md)
```

MICT-RAG-002 v1.0, jakemorganlabs.
