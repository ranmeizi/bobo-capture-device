import { Client, EVENTS, launchBrowser, logger } from 'cdp-client-tool'
import { DiscordWsListener } from './discord-ws-listener'
import { runInitialHttpSync } from './initial-http-sync'

const client = new Client({
  deviceName: "Boboan's Macos",
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

const wsListener = new DiscordWsListener({})

async function bootstrap(): Promise<void> {
  const browser = await launchBrowser()

  logger.info('[main] ① HTTP 补拉：对比数据库 ts，滚动抓取未入库消息')
  const { page, dbTs, caughtUpTs } = await runInitialHttpSync(browser)
  logger.info('[main] HTTP 补拉结束', { dbTs, caughtUpTs })

  logger.info('[main] ② WS 增量监听')
  await wsListener.start(browser, { page })
}

bootstrap().catch((err) => logger.error('[main] 启动失败', err))

process.on('SIGINT', async () => {
  logger.info('[main] 正在退出...')
  await wsListener.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await wsListener.stop()
  process.exit(0)
})

console.log('Client 已创建，事件枚举:', EVENTS)
