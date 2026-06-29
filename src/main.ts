import { Client, EVENTS, logger } from 'cdp-client-tool'
import { connectBrowser } from './connect-browser'
import { DiscordWsListener } from './discord-ws-listener'
import { runInitialHttpSync } from './initial-http-sync'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  startOutboxWorker,
  stopOutboxWorker,
} = require('../libs/outbox-worker')

const wsListener = new DiscordWsListener({})

/** 等浏览器补拉完成后再连网关，避免服务端脚本抢占/断开 Chrome */
let client: Client | null = null

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

bootstrap().catch((err) => logger.error('[main] 启动失败', err))

process.on('SIGINT', async () => {
  logger.info('[main] 正在退出...')
  stopOutboxWorker()
  await wsListener.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  stopOutboxWorker()
  await wsListener.stop()
  process.exit(0)
})
