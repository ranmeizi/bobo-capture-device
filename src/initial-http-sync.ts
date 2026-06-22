import type { Browser, HTTPResponse, Page } from 'puppeteer-core'
import { logger, sleep } from 'cdp-client-tool'
import {
  DISCORD_CHANNEL_URL,
  DISCORD_MESSAGES_API_PATTERN,
} from './discord-config'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  parseMomoNotes,
  pushMomoNotes,
  getLatestTs,
} = require('../libs/momo-message')

export type HttpSyncOptions = {
  channelUrl?: string
  messagesApiPattern?: string
  /** 滚动补拉上限，防止死循环 */
  maxScrollRounds?: number
}

export type HttpSyncResult = {
  page: Page
  dbTs: number
  caughtUpTs: number | undefined
}

class RequestSubscriber {
  private subscribes: Record<string, Array<(response: HTTPResponse) => void>> =
    {}

  constructor(private readonly page: Page) {
    this.page.on('response', (response) => {
      const url = response.url()
      for (const [pattern, listeners] of Object.entries(this.subscribes)) {
        if (url.match(new RegExp(pattern))) {
          for (const listener of listeners) {
            listener(response)
          }
        }
      }
    })
  }

  on(pattern: string, listener: (response: HTTPResponse) => void): void {
    if (!this.subscribes[pattern]) {
      this.subscribes[pattern] = [listener]
    } else {
      this.subscribes[pattern].push(listener)
    }
  }
}

async function getBodyJson(response: HTTPResponse): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    logger.error('[http-sync] 解析 JSON 失败', error)
    return null
  }
}

async function scrollElement(
  page: Page,
  selector: string,
  duration = 1000,
): Promise<void> {
  await page.evaluate(({ selector }) => {
    const els = document.querySelectorAll(selector)
    for (let i = 0; i < els.length; i++) {
      const el = els[i]
      if (el.className.includes('scroller')) {
        el.scrollBy({ top: -500, behavior: 'smooth' })
      }
    }
  }, { selector })
  await sleep(duration)
}

async function openChannelPage(page: Page, channelUrl: string): Promise<void> {
  await page.goto(channelUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    (part) => window.location.href.includes(part),
    { timeout: 60_000 },
    '/channels/',
  )
  await sleep(5000)
}

async function waitForChannelScroller(
  page: Page,
  maxAttempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (page.isClosed()) {
        throw new Error('page 已关闭')
      }
      await page.waitForSelector('div [data-jump-section="global"]', {
        timeout: 45_000,
      })
      return
    } catch (error) {
      const msg = String(error)
      const retriable =
        msg.includes('detached') ||
        msg.includes('closed') ||
        msg.includes('Target closed')

      if (retriable && attempt < maxAttempts) {
        logger.warn(
          `[http-sync] 页面 frame 异常，reload 重试 (${attempt}/${maxAttempts})`,
        )
        await page.reload({ waitUntil: 'domcontentloaded' })
        await sleep(5000)
        continue
      }
      throw error
    }
  }
}

/**
 * HTTP 补拉：对比数据库 latestTs，滚动频道页触发 messages 接口，push 未入库数据
 */
export async function runInitialHttpSync(
  browser: Browser,
  options: HttpSyncOptions = {},
  existingPage?: Page,
): Promise<HttpSyncResult> {
  const channelUrl = options.channelUrl ?? DISCORD_CHANNEL_URL
  const messagesApiPattern =
    options.messagesApiPattern ?? DISCORD_MESSAGES_API_PATTERN
  const maxScrollRounds = options.maxScrollRounds ?? 200

  const page = existingPage ?? (await browser.newPage())
  await page.setDefaultNavigationTimeout(0)

  let newsSmallestTs: number | undefined

  const subscriber = new RequestSubscriber(page)
  subscriber.on(
    messagesApiPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    (response) => {
      void (async () => {
        try {
          const data = await getBodyJson(response)
          if (!Array.isArray(data)) return

          const notes = parseMomoNotes(data)
          if (!notes.length) return

          const res = await pushMomoNotes(notes)
          if (res?.code === '000000') {
            newsSmallestTs = notes.reduce(
              (prev: number, curr: { utc: number }) => Math.min(prev, curr.utc),
              notes[0].utc,
            )
          }
        } catch (error) {
          logger.error('[http-sync] 处理 messages 响应失败', error)
        }
      })()
    },
  )

  const dbTs = await getLatestTs()
  logger.info('[http-sync] 数据库最新 ts:', dbTs)

  const onChannel = page.url().includes(channelUrl)
  if (!onChannel) {
    logger.info('[http-sync] 打开频道页:', channelUrl)
    await openChannelPage(page, channelUrl)
  }

  logger.info('[http-sync] 等待频道加载')
  await waitForChannelScroller(page)
  await sleep(2000)

  logger.info('[http-sync] 开始滚动补拉', { dbTs, newsSmallestTs })

  let rounds = 0
  while ((!newsSmallestTs || dbTs < newsSmallestTs) && rounds < maxScrollRounds) {
    logger.info(
      `[http-sync] 滚动 #${rounds + 1}，已抓最早 ts: ${newsSmallestTs ?? '无'}，数据库 ts: ${dbTs}`,
    )
    await scrollElement(page, `div [data-jump-section='global']`)
    rounds++
  }

  if (rounds >= maxScrollRounds) {
    logger.warn('[http-sync] 达到最大滚动次数，停止补拉')
  } else {
    logger.success('[http-sync] 补拉完成', { dbTs, caughtUpTs: newsSmallestTs })
  }

  await sleep(1000)

  return { page, dbTs, caughtUpTs: newsSmallestTs }
}
