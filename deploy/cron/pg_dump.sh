#!/usr/bin/env bash
set -euo pipefail
#
# deploy/cron/pg_dump.sh — Nightly pg_dump of the pgvector database.
#
# Usage: cron entry (run daily at 02:00 UTC):
#   0 2 * * * /bin/bash /opt/docintel/deploy/cron/pg_dump.sh >> /var/log/pg_dump.log 2>&1
#
# Rotates backups older than 7 days automatically.

BACKUP_DIR="/var/backups/pgvector"
DB_NAME="${POSTGRES_DB:-docintel}"
DB_USER="${POSTGRES_USER:-postgres}"
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"

DATE_TAG=$(date +%F)
DUMP_FILE="$BACKUP_DIR/rag_${DATE_TAG}.dump"

# pg_dump in custom format (-Fc) — vector columns included by default
echo "[$(date -Iseconds)] Starting backup of $DB_NAME → $DUMP_FILE"
pg_dump -Fc -d "$DB_NAME" -U "$DB_USER" -f "$DUMP_FILE"

# Rotate: remove dumps older than RETENTION_DAYS
echo "[$(date -Iseconds)] Rotating backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "rag_*.dump" -type f -mtime +$RETENTION_DAYS -delete

echo "[$(date -Iseconds)] Backup complete. Files on disk:"
ls -lh "$BACKUP_DIR"
