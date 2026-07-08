# Makefile — MICT-RAG-002 S06 Deployment Commands
# Usage: make <target>

.PHONY: hooks gate up down logs migrate backup restore-test reingest smoke eval-prod

# Install git hooks (run once per clone)
hooks:
	git config core.hooksPath scripts/hooks
	@echo "Hooks installed from scripts/hooks/"

# Run secret gate manually
gate:
	bash scripts/secret_gate.sh

# --- Local development ---

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

# --- Database ---

migrate:
	npx tsx scripts/migrate.ts

# --- Backup / restore / re-ingest ---

backup:
	bash deploy/cron/pg_dump.sh

restore-test:
	bash deploy/restore.sh

reingest:
	bash deploy/reingest.sh

# --- Smoke & eval ---

smoke:
	bash scripts/smoke_prod.sh

eval-prod:
	EVAL_ENV=prod npx tsx evals/run.ts && npx tsx evals/report.ts
