#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node server.mjs --sync-once
node scripts/backup-db.mjs
echo "Goon daily source sync and integrity-checked backup complete"
