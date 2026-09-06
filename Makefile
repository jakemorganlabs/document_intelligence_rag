# Makefile: MICT-RAG-002 operations commands.
# Usage: make <target>

.PHONY: hooks gate status logs restart migrate backup restore-test reingest smoke eval-prod

# Install git hooks (run once per clone)
hooks:
	git config core.hooksPath scripts/hooks
	@echo "Hooks installed from scripts/hooks/"

# Run secret gate manually
gate:
	bash scripts/secret_gate.sh

# production service (systemd unit docintel-rag, host Postgres)

status:
	systemctl status docintel-rag --no-pager

logs:
	journalctl -u docintel-rag -f

restart:
	sudo systemctl restart docintel-rag && curl -sf http://127.0.0.1:3002/health

# database

migrate:
	npx tsx scripts/migrate.ts

# backup / restore / re-ingest

backup:
	bash deploy/cron/pg_dump.sh

restore-test:
	bash deploy/restore.sh

reingest:
	bash deploy/reingest.sh

# smoke & eval

smoke:
	bash scripts/smoke_prod.sh

eval-prod:
	EVAL_ENV=prod npx tsx evals/run.ts && npx tsx evals/report.ts
