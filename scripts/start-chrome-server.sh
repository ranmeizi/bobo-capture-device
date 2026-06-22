#!/usr/bin/env bash
# 启动带 CDP 远程调试的 Chrome（供 puppeteer connect，非 PM2 自动拉起）
set -euo pipefail

CHROME_DEBUG_PORT="${CHROME_DEBUG_PORT:-9222}"
CHROME_USER_DATA="${CHROME_USER_DATA:-${HOME}/.chrome-cdp-bobo}"

if curl -sf "http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome CDP 已在 localhost:${CHROME_DEBUG_PORT} 运行"
  exit 0
fi

mkdir -p "${CHROME_USER_DATA}"

start_linux() {
  for bin in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "${bin}" >/dev/null 2>&1; then
      echo "使用 ${bin} 启动，profile: ${CHROME_USER_DATA}"
      nohup "${bin}" \
        --remote-debugging-port="${CHROME_DEBUG_PORT}" \
        --user-data-dir="${CHROME_USER_DATA}" \
        --no-first-run \
        --no-default-browser-check \
        --disable-dev-shm-usage \
        >>"${CHROME_USER_DATA}/chrome.log" 2>&1 &
      return 0
    fi
  done
  echo "未找到 google-chrome / chromium，请先安装 Chrome"
  exit 1
}

case "$(uname -s)" in
  Darwin)
    echo "macOS: 启动 Google Chrome (port ${CHROME_DEBUG_PORT})"
    open -na "Google Chrome" --args \
      --remote-debugging-port="${CHROME_DEBUG_PORT}" \
      --user-data-dir="${CHROME_USER_DATA}" \
      --no-first-run \
      --no-default-browser-check
    ;;
  Linux)
    start_linux
    ;;
  *)
    echo "不支持的操作系统: $(uname -s)"
    exit 1
    ;;
esac

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version" >/dev/null 2>&1; then
    echo "Chrome CDP 就绪: http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version"
    exit 0
  fi
  sleep 1
done

echo "Chrome 已启动但 CDP 端口未响应，请检查 ${CHROME_USER_DATA}/chrome.log"
exit 1
