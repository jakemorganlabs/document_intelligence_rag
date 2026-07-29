#!/usr/bin/env bash
# Start the RAG HTTP server. Env is provided by systemd EnvironmentFile
# (deploy/.env.production); do not source .env here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

export PORT="${PORT:-3002}"

exec npx tsx src/server.ts
