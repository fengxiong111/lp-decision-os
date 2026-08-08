#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="$project_root/.local-data/runtime"
log_dir="$project_root/.local-data/logs"
lock_dir="$runtime_dir/supervisor.lock"
pid_file="$runtime_dir/supervisor.pid"
backend_port="${LP_BACKEND_PORT:-${LP_PORT:-3838}}"

mkdir -p "$runtime_dir" "$log_dir"

export LP_EVENT_DB_PATH="${LP_EVENT_DB_PATH:-$project_root/.local-data/lp-events.sqlite}"
export LP_RPC_RATE_DB_PATH="${LP_RPC_RATE_DB_PATH:-$project_root/.local-data/rpc-governor.sqlite}"
export LP_WALLET_CONFIG_PATH="${LP_WALLET_CONFIG_PATH:-$project_root/.local-data/read-only-wallet.json}"
export LP_BACKEND_PORT="$backend_port"
# iPad/局域网访问是本地终端的默认用法；设置 LP_ENABLE_LAN=0 可恢复仅本机监听。
export LP_ENABLE_LAN="${LP_ENABLE_LAN:-1}"
export LP_HOST="${LP_HOST:-0.0.0.0}"

action="${1:-start}"

read_supervisor_pid() {
  [ -f "$pid_file" ] || return 0
  tr -d '[:space:]' < "$pid_file"
}

is_running() {
  local candidate="$1"
  [ -n "$candidate" ] && kill -0 "$candidate" 2>/dev/null
}

stop_by_pid() {
  local candidate="$1"
  is_running "$candidate" || return 0
  kill -TERM "$candidate" 2>/dev/null || true
  for _ in {1..40}; do
    is_running "$candidate" || return 0
    sleep 0.25
  done
  kill -KILL "$candidate" 2>/dev/null || true
}

if [ "$action" = "stop" ]; then
  existing_pid="$(read_supervisor_pid || true)"
  if [ -n "$existing_pid" ]; then stop_by_pid "$existing_pid"; fi
  rm -f "$pid_file"
  rmdir "$lock_dir" 2>/dev/null || true
  echo "LP Alpha Terminal supervisor stopped"
  exit 0
fi

if [ "$action" != "start" ]; then
  echo "用法：scripts/supervisor.sh [start|stop]" >&2
  exit 2
fi

if ! mkdir "$lock_dir" 2>/dev/null; then
  existing_pid="$(read_supervisor_pid || true)"
  if is_running "$existing_pid"; then
    echo "Supervisor 已运行，PID $existing_pid" >&2
    exit 1
  fi
  rm -rf "$lock_dir"
  mkdir "$lock_dir"
fi

echo "$$" > "$pid_file"
child_backend=""
child_indexer=""
child_backfill=""
child_metrics=""
retry_backend=0
retry_indexer=0
retry_backfill=0
retry_metrics=0

cleanup() {
  trap - EXIT INT TERM
  for child in "$child_backend" "$child_indexer" "$child_backfill" "$child_metrics"; do
    [ -n "$child" ] || continue
    kill -TERM "$child" 2>/dev/null || true
  done
  for _ in {1..20}; do
    running=0
    for child in "$child_backend" "$child_indexer" "$child_backfill" "$child_metrics"; do
      if [ -n "$child" ] && is_running "$child"; then running=1; fi
    done
    [ "$running" -eq 0 ] && break
    sleep 0.25
  done
  for child in "$child_backend" "$child_indexer" "$child_backfill" "$child_metrics"; do
    if [ -n "$child" ] && is_running "$child"; then kill -KILL "$child" 2>/dev/null || true; fi
  done
  rm -f "$pid_file"
  rmdir "$lock_dir" 2>/dev/null || true
  exit 0
}
trap cleanup EXIT INT TERM

start_child() {
  local name="$1"
  local script="$2"
  local log_file="$log_dir/$name.log"
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] start $name" >> "$log_file"
  (cd "$project_root" && exec node --import tsx "$script") >> "$log_file" 2>&1 &
  case "$name" in
    backend) child_backend=$! ;;
    indexer) child_indexer=$! ;;
    backfill) child_backfill=$! ;;
    metrics) child_metrics=$! ;;
  esac
}

restart_child() {
  local name="$1"
  local script="$2"
  local retry_name="retry_$name"
  local retry_value="${!retry_name:-0}"
  local delay=$((2 ** retry_value))
  [ "$delay" -le 60 ] || delay=60
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $name exited; restart in ${delay}s" >> "$log_dir/supervisor.log"
  sleep "$delay"
  [ "$retry_value" -lt 6 ] && printf -v "$retry_name" '%s' "$((retry_value + 1))"
  start_child "$name" "$script"
}

start_child backend apps/backend/src/server.ts
start_child indexer scripts/indexer-worker.ts
start_child backfill scripts/backfill-worker.ts
start_child metrics scripts/metrics-worker.ts

for _ in {1..60}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$backend_port/api/ping" >/dev/null 2>&1; then
    echo "[supervisor] Fastify ready on $backend_port"
    break
  fi
  sleep 0.5
done

while true; do
  if ! is_running "$child_backend"; then wait "$child_backend" 2>/dev/null || true; restart_child backend apps/backend/src/server.ts; fi
  if ! is_running "$child_indexer"; then wait "$child_indexer" 2>/dev/null || true; restart_child indexer scripts/indexer-worker.ts; fi
  if ! is_running "$child_backfill"; then wait "$child_backfill" 2>/dev/null || true; restart_child backfill scripts/backfill-worker.ts; fi
  if ! is_running "$child_metrics"; then wait "$child_metrics" 2>/dev/null || true; restart_child metrics scripts/metrics-worker.ts; fi
  sleep 2
done
