#!/usr/bin/env bash
set -uo pipefail
# Weekly restore test for the nightly docintel dumps.
#
# The nightly job (deploy/cron/pg_dump.sh) only proves a dump was written.
# This job proves the newest dump restores into a scratch pgvector container
# and still answers an ANN query. It runs deploy/restore.sh, keeps a dated
# log, appends one line to a rolling status file, and posts to Slack on
# failure when SLACK_WEBHOOK_URL is set.
#
# Install (as the user that can run docker):
#   30 3 * * 0  /opt/rag/deploy/cron/restore_test.sh
#
# Env (all optional):
#   RESTORE_LOG_DIR     default /var/log/docintel      (falls back to $HOME/backups/rag)
#   SLACK_WEBHOOK_URL   alert target on FAIL
#   BACKUP_DIR          passed through to restore.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

LOG_DIR="${RESTORE_LOG_DIR:-/var/log/docintel}"
if ! mkdir -p "$LOG_DIR" 2>/dev/null || [[ ! -w "$LOG_DIR" ]]; then
  LOG_DIR="${HOME}/backups/rag"
  mkdir -p "$LOG_DIR"
fi

DATE_TAG=$(date +%F)
LOG_FILE="$LOG_DIR/restore_test_${DATE_TAG}.log"
STATUS_FILE="$LOG_DIR/restore_test_status.log"

echo "[$(date -Iseconds)] restore test start" | tee "$LOG_FILE"
bash "$REPO_ROOT/deploy/restore.sh" 2>&1 | tee -a "$LOG_FILE"
RC=${PIPESTATUS[0]}

if [[ "$RC" -eq 0 ]]; then
  RESULT="PASS"
else
  RESULT="FAIL"
fi
echo "[$(date -Iseconds)] restore test ${RESULT} (exit ${RC})" | tee -a "$LOG_FILE"
echo "$(date -Iseconds) ${RESULT} exit=${RC} log=${LOG_FILE}" >> "$STATUS_FILE"

# keep 8 weeks of logs
find "$LOG_DIR" -name 'restore_test_*.log' -type f -mtime +56 -delete 2>/dev/null || true

if [[ "$RESULT" == "FAIL" && -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  TAIL=$(tail -n 5 "$LOG_FILE" | sed 's/"/\\"/g')
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"docintel restore test FAILED on $(hostname) (${DATE_TAG})\\n${TAIL}\"}" \
    "$SLACK_WEBHOOK_URL" >/dev/null || true
fi

exit "$RC"
