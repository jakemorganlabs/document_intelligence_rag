# Runbook — MICT-RAG-002 Production Operations

> This runbook is written for a second person redeploying from scratch. Every command is copy-pasteable (substitute secrets from `.env.production`).

## Table of contents

1. [Redeploy](#1-redeploy)
2. [Migrate database](#2-migrate-database)
3. [Rotate HMAC secret](#3-rotate-hmac-secret)
4. [Restore from backup](#4-restore-from-backup)
5. [Re-ingest corpus](#5-re-ingest-corpus)
6. [Check DLQ](#6-check-dlq--dead-letter-queue)
7. [Closeout protocol](#7-closeout-evidence-commit-protocol)
8. [Release notes template](#8-release-notes-template)

---

## 1. Redeploy

Pull latest code and restart the stack:

```bash
cd /opt/docintel-002
# pull
git pull origin main
# copy env
cp deploy/.env.production.example .env.production
# (operator: fill secrets)
source .env.production
# restart
docker compose -f deploy/docker-compose.yml up -d
# verify health
curl -s http://localhost:5678/webhook/health | jq .
```

---

## 2. Migrate database

Apply pending migrations (safe to re-run):

```bash
npx tsx scripts/migrate.ts
```

Fresh rebuild (drops everything — operator confirmation required):

```bash
npx tsx scripts/migrate-fresh.ts
```

---

## 3. Rotate HMAC secret

This procedure must be executed **once now** to verify steps, not first during an incident.

1. **Generate new secret**:
   ```bash
   openssl rand -hex 32
   ```

2. **Update `.env.production`**:
   ```
   HMAC_SECRET=<new-secret>
   ```

3. **Recreate n8n** (it reads HMAC_SECRET at startup):
   ```bash
   docker compose -f deploy/docker-compose.yml up -d --no-deps --force-recreate n8n
   ```

4. **Verify existing clients fail** with old signature:
   ```bash
   bash scripts/smoke_prod.sh
   ```

5. **Notify clients** with the new secret and a rotation deadline.

6. **Verify new clients succeed** after updating their signing code.

---

## 4. Restore from backup

The nightly backup is in `/var/backups/pgvector/rag_YYYY-MM-DD.dump`.

```bash
# 1. Stop the live stack
docker compose -f deploy/docker-compose.yml down

# 2. Remove old volume (CAREFUL — this destroys live data)
docker volume rm docintel_pgvector_data

# 3. Start postgres only
docker compose -f deploy/docker-compose.yml up -d postgres

# 4. Find newest dump
NEWEST=$(find /var/backups/pgvector -name 'rag_*.dump' -type f -print0 | xargs -0 ls -t | head -n 1)

# 5. Restore
pg_restore --no-owner --dbname=docintel --username=postgres -Fc "${NEWEST}"

# 6. Restart full stack
docker compose -f deploy/docker-compose.yml up -d

# 7. Verify with ANN sanity
curl -s http://localhost:5678/webhook/health && bash deploy/restore.sh
```

---

## 5. Re-ingest corpus

Operator drops PDFs into `./corpus/` on the host, then:

```bash
bash deploy/reingest.sh
```

If `reingest.sh` exits non-zero with "zero files ingested", check the UID/GID pitfall (§7):

```bash
# Fix ownership so containers can read the bind-mount
sudo chown -R 1000:1000 ./corpus/
chmod -R a+r ./corpus/
# Then retry
bash deploy/reingest.sh
```

---

## 6. Check DLQ (dead-letter queue)

```bash
# From inside the Postgres container
docker exec -it docintel-postgres psql -U postgres -d docintel -c "
  SELECT created_at, stage, error_code, error, item_snapshot
  FROM dead_letters
  ORDER BY created_at DESC
  LIMIT 20;
"
```

---

## 7. Closeout evidence commit protocol

After the operator has deployed and gathered evidence:

```bash
git checkout -b closeout-evidence
# Drop evidence files into docs/evidence/:
#   - eval_report_prod.md
#   - smoke_prod_output.txt
#   - restore_test.txt
bash scripts/secret_gate.sh          # evidence is the likeliest place a URL/token sneaks in
git add docs/evidence README.md && git commit -m "closeout: production evidence — prod evals green, HMAC enforcement proof, restore tested"
git push -u origin closeout-evidence # merge, then tag if not already tagged
```

The repo is reviewer-complete only after this commit lands.

---

## 8. Release notes template

Every release must carry a non-blank release note with this structure:

```markdown
## Highlights
- (3 bullets: what changed, why it matters)
- 

## Evidence
- [eval report](docs/evidence/eval_report_*.md)
- [smoke test](docs/evidence/smoke_prod_output.txt)
- [restore test](docs/evidence/restore_test.txt)

## Docs
- [SRS/TDD](docs/document_intelligence_rag_srs_tdd.md)
- [Runbook](docs/runbook.md)
```

---

*MICT-RAG-002 v1.0 — Session 6 — jakemorganlabs*
