import { fork, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { Client, EVENTS, logger } from 'cdp-client-tool'
import { connectBrowser } from './connect-browser'
import { DiscordWsListener } from './discord-ws-listener'
import { runInitialHttpSync } from './initial-http-sync'
import {
  flushSentry,
  reportProcessExit,
  reportProcessStart,
  reportProcessStartFailed,
} from './sentry-lifecycle'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  startOutboxWorker,
  stopOutboxWorker,
} = require('../libs/outbox-worker')

/** 等浏览器补拉完成后再连网关，避免服务端脚本抢占/断开 Chrome */
let client: Client | null = null
let shuttingDown = false
let clashChild: ChildProcess | null = null

function startClashMonitor(): void {
  const script = path.join(__dirname, 'clash-monitor/index.js')
  if (!fs.existsSync(script)) {
    logger.warn('[clash] 未找到监控脚本，跳过', script)
    return
  }
  clashChild = fork(script, [], { stdio: 'inherit' })
  clashChild.on('exit', (code, signal) => {
    logger.warn('[clash] 监控进程退出', { code, signal })
    clashChild = null
  })
}

function stopClashMonitor(): void {
  clashChild?.kill('SIGTERM')
  clashChild = null
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`[main] 正在退出 (${reason})...`)
  // 先发出退出事件。CDP detach 可能卡住，pm2 会在 kill_timeout 后 SIGKILL。
  reportProcessExit(reason, exitCode)
  await flushSentry(4000)
  stopClashMonitor()
  stopOutboxWorker()
  try {
    await Promise.race([
      wsListener.stop(reason),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  } catch (err) {
    logger.error('[main] 停止 WS 监听失败', err)
  }
  process.exit(exitCode)
}

const wsListener = new DiscordWsListener({
  onCircuitOpen: () => {
    void shutdown('circuit_open', 1)
  },
})

function createGatewayClient(): Client {
  return new Client({
    deviceName: "lenovo L79031",
    gateways: [
      {
        name: 'boboan.net',
        uri: 'https://boboan.net/cct_ws',
        opts: {
          transports: ['websocket'],
          path: '/socket.io',
        },
      },
    ],
  })
}

async function bootstrap(): Promise<void> {
  reportProcessStart()
  startClashMonitor()
  startOutboxWorker()

  const browser = await connectBrowser()

  logger.info('[main] ① HTTP 补拉：对比数据库 ts，滚动抓取未入库消息')
  const { page, dbTs, caughtUpTs } = await runInitialHttpSync(browser)
  logger.info('[main] HTTP 补拉结束', { dbTs, caughtUpTs })

  logger.info('[main] ② WS 增量监听')
  await wsListener.start(browser, { page })

  logger.info('[main] ③ 连接网关（补拉完成后才连，避免脚本抢占浏览器）')
  client = createGatewayClient()
  logger.success('[main] 启动完成', { events: EVENTS })
}

bootstrap().catch(async (err) => {
  logger.error('[main] 启动失败', err)
  reportProcessStartFailed(err)
  await flushSentry()
})

process.on('SIGINT', () => {
  void shutdown('SIGINT', 0)
})

process.on('SIGTERM', () => {
  void shutdown('SIGTERM', 0)
})

process.on('uncaughtException', (err) => {
  logger.error('[main] uncaughtException', err)
  if (shuttingDown) process.exit(1)
  void shutdown('uncaughtException', 1)
})
