import { launchBrowser, logger, sleep } from 'cdp-client-tool'

const DEFAULT_PORT = 9222
const DEFAULT_RETRIES = 12
const DEFAULT_INTERVAL_MS = 5000

export type ConnectBrowserOptions = {
  port?: number
  maxRetries?: number
  intervalMs?: number
}

function isConnectionRefused(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err)
  const cause = (err as { cause?: { code?: string } })?.cause
  return (
    msg.includes('ECONNREFUSED') ||
    cause?.code === 'ECONNREFUSED' ||
    msg.includes('connect ECONNREFUSED')
  )
}

/**
 * launchBrowser 只连接本机已开启 --remote-debugging-port 的 Chrome，不会自己启动浏览器。
 */
export async function connectBrowser(options: ConnectBrowserOptions = {}) {
  const port = options.port ?? DEFAULT_PORT
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const browser = await launchBrowser()
      logger.success(`[browser] 已连接 Chrome CDP (localhost:${port})`)
      return browser
    } catch (err) {
      if (!isConnectionRefused(err) || attempt === maxRetries) {
        logger.error(
          `[browser] 连接 Chrome 失败。请先在本机启动带远程调试的 Chrome：\n` +
            `  bash scripts/start-chrome-server.sh\n` +
            `或 macOS: bash open-chrome.sh\n` +
            `确认: curl http://127.0.0.1:${port}/json/version`,
        )
        throw err
      }

      logger.warn(
        `[browser] Chrome CDP 未就绪 (${attempt}/${maxRetries})，${intervalMs / 1000}s 后重试…`,
      )
      await sleep(intervalMs)
    }
  }

  throw new Error('unreachable')
}
