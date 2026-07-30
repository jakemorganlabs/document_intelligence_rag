#!/usr/bin/env bash
set -euo pipefail
# Nightly pg_dump of the docintel database (host Postgres 18).
# Dumps as the postgres OS user, redirect writes the file as the invoking user.

BACKUP_DIR="/var/backups/pgvector"
DB_NAME="docintel"
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"
DATE_TAG=$(date +%F)
DUMP_FILE="$BACKUP_DIR/rag_${DATE_TAG}.dump"

echo "[$(date -Iseconds)] Backing up $DB_NAME -> $DUMP_FILE"
sudo -u postgres pg_dump -Fc -d "$DB_NAME" > "$DUMP_FILE"

echo "[$(date -Iseconds)] Rotating backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "rag_*.dump" -type f -mtime +$RETENTION_DAYS -delete

echo "[$(date -Iseconds)] Done. Files on disk:"
ls -lh "$BACKUP_DIR"
