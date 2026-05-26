#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p logs

cmd="${1:-start}"

case "$cmd" in
  start)
    pm2 start ecosystem.config.cjs
    pm2 save 2>/dev/null || true
    ;;
  stop)
    pm2 stop bobo-cap
    ;;
  restart)
    pm2 restart bobo-cap
    ;;
  delete)
    pm2 delete bobo-cap
    ;;
  logs)
    pm2 logs bobo-cap
    ;;
  status)
    pm2 status bobo-cap
    ;;
  *)
    echo "用法: $0 {start|stop|restart|delete|logs|status}"
    exit 1
    ;;
esac
