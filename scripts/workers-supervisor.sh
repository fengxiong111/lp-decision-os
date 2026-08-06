#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

indexer_pid=""
backfill_pid=""
metrics_pid=""

stop_children() {
  trap - EXIT INT TERM
  for pid in "$indexer_pid" "$backfill_pid" "$metrics_pid"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
  done
  exit 0
}
trap stop_children EXIT INT TERM

start_worker() {
  local name="$1"
  local script=""
  case "$name" in
    indexer) script="scripts/indexer-worker.ts" ;;
    backfill) script="scripts/backfill-worker.ts" ;;
    metrics) script="scripts/metrics-worker.ts" ;;
  esac
  echo "[supervisor] 启动 ${name}（SQLite 游标持久化，重启不清零）"
  bash -c "cd '$project_root' && exec node --import tsx '$script'" &
  case "$name" in
    indexer) indexer_pid=$! ;;
    backfill) backfill_pid=$! ;;
    metrics) metrics_pid=$! ;;
  esac
}

for name in indexer backfill metrics; do start_worker "$name"; done

while true; do
  for name in indexer backfill metrics; do
    case "$name" in
      indexer) pid="$indexer_pid" ;;
      backfill) pid="$backfill_pid" ;;
      metrics) pid="$metrics_pid" ;;
    esac
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      start_worker "$name"
    fi
  done
  sleep 2
done
