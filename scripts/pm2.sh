#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p logs

cmd="${1:-start}"

case "$cmd" in
  start)
    if ! curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
      echo "Chrome CDP (9222) 未运行，先启动 Chrome…"
      bash scripts/start-chrome-server.sh
    fi
    echo "编译 TypeScript…"
    pnpm run build
    if [ ! -f dist/instrument.mjs ] || [ ! -f dist/main.js ]; then
      echo "错误: dist/main.js 或 dist/instrument.mjs 不存在"
      exit 1
    fi
    # delete 后再 start，确保 node_args / script 生效
    pm2 delete bobo-cap 2>/dev/null || true
    pm2 start ecosystem.config.cjs
    pm2 save 2>/dev/null || true
    ;;
  stop)
    pm2 stop bobo-cap
    ;;
  restart)
    echo "编译 TypeScript…"
    pnpm run build
    if [ ! -f dist/instrument.mjs ] || [ ! -f dist/main.js ]; then
      echo "错误: dist/main.js 或 dist/instrument.mjs 不存在"
      exit 1
    fi
    pm2 delete bobo-cap 2>/dev/null || true
    pm2 start ecosystem.config.cjs
    pm2 save 2>/dev/null || true
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
