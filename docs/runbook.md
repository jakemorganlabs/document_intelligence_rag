# Runbook - MICT-RAG-002 Production Operations

Written for a second person redeploying from scratch. Every command is copy-pasteable. Sub secrets in from `.env.production`.

## Table of contents

1. [Redeploy](#1-redeploy)
2. [Migrate database](#2-migrate-database)
3. [Rotate HMAC secret](#3-rotate-hmac-secret)
4. [Restore from backup](#4-restore-from-backup)
5. [Re-ingest corpus](#5-re-ingest-corpus)
6. [Check DLQ](#6-check-dlq--dead-letter-queue)
7. [Closeout protocol](#7-closeout-evidence-commit-protocol)
8. [Release notes template](#8-release-notes-template)

## 1. Redeploy

Pull latest code and restart the stack:

```bash
cd /opt/docintel-002
git pull origin main
cp deploy/.env.production.example .env.production
# fill secrets, then:
source .env.production
docker compose -f deploy/docker-compose.yml up -d
curl -s http://localhost:5678/webhook/health | jq .
```

## 2. Migrate database

Apply pending migrations. Safe to re-run:

```bash
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
2. Set it in `.env.production`:
   ```
   HMAC_SECRET=<new-secret>
   ```
3. Recreate n8n so it picks up the new secret at startup:
   ```bash
   docker compose -f deploy/docker-compose.yml up -d --no-deps --force-recreate n8n
   ```
4. Confirm old clients fail:
   ```bash
   bash scripts/smoke_prod.sh
   ```
5. Hand the new secret to clients with a rotation deadline.
6. Confirm updated clients succeed.

## 4. Restore from backup

Nightly backup lives at `/var/backups/pgvector/rag_YYYY-MM-DD.dump`.

```bash
docker compose -f deploy/docker-compose.yml down
docker volume rm docintel_pgvector_data           # destroys live data
docker compose -f deploy/docker-compose.yml up -d postgres

NEWEST=$(find /var/backups/pgvector -name 'rag_*.dump' -type f -print0 | xargs -0 ls -t | head -n 1)
pg_restore --no-owner --dbname=docintel --username=postgres -Fc "${NEWEST}"

docker compose -f deploy/docker-compose.yml up -d
curl -s http://localhost:5678/webhook/health && bash deploy/restore.sh
```

## 5. Re-ingest corpus

Drop PDFs into `./corpus/` on the host, then:

```bash
bash deploy/reingest.sh
```

If `reingest.sh` exits non-zero with "zero files ingested", the containers probably cannot read the bind-mount. Fix ownership and retry:

```bash
sudo chown -R 1000:1000 ./corpus/
chmod -R a+r ./corpus/
bash deploy/reingest.sh
```

## 6. Check DLQ (dead-letter queue)

```bash
docker exec -it docintel-postgres psql -U postgres -d docintel -c "
  SELECT created_at, stage, error_code, error, item_snapshot
  FROM dead_letters
  ORDER BY created_at DESC
  LIMIT 20;
"
```

## 7. Closeout evidence commit protocol

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

## 8. Release notes template

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
- [SRS/TDD](docs/document_intelligence_rag_srs_tdd.md)
- [Runbook](docs/runbook.md)
```

MICT-RAG-002 v1.0, Session 6, jakemorganlabs.