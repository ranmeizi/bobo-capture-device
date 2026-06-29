import type { Browser, CDPSession, Page } from 'puppeteer-core'
import { logger, sleep } from 'cdp-client-tool'
import {
  DISCORD_CHANNEL_ID,
  DISCORD_CHANNEL_URL,
  DISCORD_GUILD_ID,
} from './discord-config'
import { runInitialHttpSync } from './initial-http-sync'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  DiscordGatewayDecoder,
  isDiscordGatewayUrl,
} = require('../libs/discord-gateway-decoder')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseMomoNote } = require('../libs/momo-message')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const outbox = require('../libs/outbox')

const DEFAULT_GUILD_ID = DISCORD_GUILD_ID

export type DiscordWsListenerStartOptions = {
  /** HTTP 补拉完成后传入同一 page，避免重复开 tab */
  page?: Page
}

export type DiscordWsListenerOptions = {
  channelId?: string
  guildId?: string
  channelUrl?: string
  channelUrlPattern?: string
  /** 两次恢复之间的最短间隔 */
  recoveryCooldownMs?: number
  /** 超过此时间无 gateway 帧视为异常 */
  wsStaleThresholdMs?: number
  /** 健康检查间隔 */
  healthCheckIntervalMs?: number
  /** 熔断：窗口期内连续失败次数上限，超出则 exit(1) 交给 pm2 重启 */
  circuitBreakerMaxFailures?: number
  /** 熔断计数窗口 */
  circuitBreakerWindowMs?: number
  /** 恢复后等待 READY 的超时 */
  readyTimeoutMs?: number
  /** 熔断触发时回调，默认 process.exit(1) */
  onCircuitOpen?: () => void
}

export type DiscordWsListenerState = {
  connected: boolean
  lastFrameAt: number | null
  lastMessageAt: number | null
  circuitFailures: number
}

export class DiscordWsListener {
  private browser: Browser | null = null
  private page: Page | null = null
  private cdp: CDPSession | null = null
  private decoder = new DiscordGatewayDecoder()
  private gatewayRequestIds = new Set<string>()
  private lastFrameAt: number | null = null
  private lastMessageAt: number | null = null
  private gatewayConnected = false
  private recovering = false
  private lastRecoveryAt = 0
  private circuitFailures = 0
  private circuitWindowStartedAt = 0
  private healthTimer: NodeJS.Timeout | null = null
  private readonly options: Required<
    Omit<DiscordWsListenerOptions, 'onCircuitOpen' | 'channelId' | 'guildId' | 'channelUrl' | 'channelUrlPattern'>
  > & {
    channelId: string
    guildId: string
    channelUrl: string
    channelUrlPattern: string
    onCircuitOpen: () => void
  }

  constructor(options: DiscordWsListenerOptions) {
    const guildId = options.guildId ?? DEFAULT_GUILD_ID
    const channelId = options.channelId ?? DISCORD_CHANNEL_ID
    this.options = {
      guildId,
      channelUrl: options.channelUrl ?? DISCORD_CHANNEL_URL,
      channelUrlPattern: options.channelUrlPattern ?? channelId,
      recoveryCooldownMs: options.recoveryCooldownMs ?? 30_000,
      wsStaleThresholdMs: options.wsStaleThresholdMs ?? 120_000,
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? 60_000,
      circuitBreakerMaxFailures: options.circuitBreakerMaxFailures ?? 3,
      circuitBreakerWindowMs: options.circuitBreakerWindowMs ?? 10 * 60 * 1000,
      readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
      channelId,
      onCircuitOpen: options.onCircuitOpen ?? (() => process.exit(1)),
    }
  }

  getState(): DiscordWsListenerState {
    return {
      connected: this.gatewayConnected,
      lastFrameAt: this.lastFrameAt,
      lastMessageAt: this.lastMessageAt,
      circuitFailures: this.circuitFailures,
    }
  }

  async start(
    browser: Browser,
    startOpts: DiscordWsListenerStartOptions = {},
  ): Promise<void> {
    this.browser = browser
    this.circuitWindowStartedAt = Date.now()

    if (startOpts.page) {
      this.page = startOpts.page
      await this.attachCdp(startOpts.page)
      logger.info('[discord-ws] HTTP 补拉完成，reload 挂载 WS 监听')
      await startOpts.page.reload({ waitUntil: 'domcontentloaded' })
      logger.info(`[discord-ws] 监听 tab: ${startOpts.page.url()}`)
    } else {
      await this.attachToDiscordTab()
    }

    this.startHealthCheck()
  }

  async stop(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    await this.detachCdp()
    this.page = null
    this.browser = null
    this.gatewayConnected = false
    this.gatewayRequestIds.clear()
    this.decoder.reset()
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      void this.checkHealth()
    }, this.options.healthCheckIntervalMs)
  }

  private async checkHealth(): Promise<void> {
    if (this.recovering) return

    const stale =
      !this.lastFrameAt ||
      Date.now() - this.lastFrameAt > this.options.wsStaleThresholdMs

    if (stale) {
      logger.warn('[discord-ws] 健康检查：长时间无 gateway 帧，触发熔断恢复', {
        lastFrameAt: this.lastFrameAt,
        connected: this.gatewayConnected,
      })
      await this.tripCircuitBreaker('ws-stale')
    }
  }

  private recordCircuitFailure(): void {
    const now = Date.now()
    if (now - this.circuitWindowStartedAt > this.options.circuitBreakerWindowMs) {
      this.circuitFailures = 0
      this.circuitWindowStartedAt = now
    }
    this.circuitFailures++
  }

  private resetCircuitBreaker(): void {
    this.circuitFailures = 0
    this.circuitWindowStartedAt = Date.now()
  }

  private async tripCircuitBreaker(reason: string): Promise<void> {
    this.recordCircuitFailure()

    if (this.circuitFailures > this.options.circuitBreakerMaxFailures) {
      logger.error(
        `[discord-ws] 熔断打开：${this.circuitFailures} 次恢复失败，退出进程（pm2 将重启）`,
      )
      this.options.onCircuitOpen()
      return
    }

    await this.recoverFromDisconnect(reason)
  }

  private async recoverFromDisconnect(reason: string): Promise<void> {
    if (this.recovering) return
    if (Date.now() - this.lastRecoveryAt < this.options.recoveryCooldownMs) {
      logger.warn(`[discord-ws] 恢复冷却中，跳过 (${reason})`)
      return
    }

    this.recovering = true
    this.lastRecoveryAt = Date.now()
    this.gatewayConnected = false

    try {
      logger.warn(
        `[discord-ws] 熔断恢复 (${this.circuitFailures}/${this.options.circuitBreakerMaxFailures}): ${reason}`,
      )

      await this.reloadTab()
      await sleep(3000)

      if (this.browser && this.page) {
        await runInitialHttpSync(this.browser, {}, this.page)
      }

      const ready = await this.waitForReady(this.options.readyTimeoutMs)
      if (ready) {
        this.resetCircuitBreaker()
        logger.success('[discord-ws] 恢复完成，Gateway READY')
      } else {
        logger.error('[discord-ws] 恢复后未收到 READY')
      }
    } catch (err) {
      logger.error('[discord-ws] 恢复失败', err)
    } finally {
      this.recovering = false
    }
  }

  private waitForReady(timeoutMs: number): Promise<boolean> {
    if (this.gatewayConnected) return Promise.resolve(true)

    return new Promise((resolve) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (this.gatewayConnected) {
          clearInterval(timer)
          resolve(true)
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(timer)
          resolve(false)
        }
      }, 500)
    })
  }

  private async reloadTab(): Promise<void> {
    if (!this.page) {
      await this.attachToDiscordTab()
      return
    }

    logger.info('[discord-ws] reload tab')
    this.decoder.reset()
    this.gatewayRequestIds.clear()
    this.gatewayConnected = false

    await this.detachCdp()
    await this.attachCdp(this.page)
    await this.page.reload({ waitUntil: 'domcontentloaded' })
  }

  private async ensureDiscordPage(): Promise<{ page: Page; needsNavigation: boolean }> {
    if (!this.browser) {
      throw new Error('browser 未连接')
    }

    const pages = await this.browser.pages()
    const page = pages.find((p) => p.url().includes(this.options.channelUrlPattern))

    if (!page) {
      logger.info(
        `[discord-ws] 未找到 Discord tab，新建页面: ${this.options.channelUrl}`,
      )
      const newPage = await this.browser.newPage()
      await newPage.setDefaultNavigationTimeout(0)
      return { page: newPage, needsNavigation: true }
    }

    return { page, needsNavigation: false }
  }

  private async attachToDiscordTab(): Promise<void> {
    const { page, needsNavigation } = await this.ensureDiscordPage()
    this.page = page

    await this.attachCdp(page)

    if (needsNavigation) {
      logger.info(`[discord-ws] 打开频道: ${this.options.channelUrl}`)
      await page.goto(this.options.channelUrl, {
        waitUntil: 'domcontentloaded',
      })
    } else {
      logger.info('[discord-ws] reload tab，重建 Gateway WS 监听')
      await page.reload({ waitUntil: 'domcontentloaded' })
    }

    logger.info(`[discord-ws] 监听 tab: ${page.url()}`)
  }

  private async attachCdp(page: Page): Promise<void> {
    await this.detachCdp()

    this.cdp = await page.target().createCDPSession()
    await this.cdp.send('Network.enable')

    this.cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
      if (isDiscordGatewayUrl(url)) {
        this.gatewayRequestIds.add(requestId)
        logger.info('[discord-ws] Gateway WS 已创建', url)
      }
    })

    this.cdp.on('Network.webSocketClosed', ({ requestId }) => {
      if (!this.gatewayRequestIds.has(requestId)) return
      this.gatewayRequestIds.delete(requestId)
      this.gatewayConnected = false
      logger.warn('[discord-ws] Gateway WS 已关闭')
      void this.tripCircuitBreaker('gateway-closed')
    })

    this.cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      this.handleGatewayFrame(requestId, response.opcode, response.payloadData)
    })

    this.cdp.on('Network.webSocketFrameSent', ({ requestId, response }) => {
      this.handleGatewayFrame(requestId, response.opcode, response.payloadData)
    })
  }

  private async detachCdp(): Promise<void> {
    if (!this.cdp) return
    try {
      await this.cdp.detach()
    } catch {
      // tab 可能已关闭
    }
    this.cdp = null
  }

  private handleGatewayFrame(
    requestId: string,
    opcode: number,
    payloadData: string,
  ): void {
    if (!this.gatewayRequestIds.has(requestId)) return

    this.lastFrameAt = Date.now()

    if (opcode !== 2) return

    const payload = Buffer.from(payloadData, 'base64')

    void this.decoder
      .decodeFrame(payload)
      .then((message) => {
        if (!message) return
        this.onGatewayMessage(message)
      })
      .catch((err) => {
        logger.error('[discord-ws] 解码失败', err)
      })
  }

  private onGatewayMessage(message: {
    op?: number
    t?: string
    d?: Record<string, unknown>
  }): void {
    if (message.op === 10 || message.op === 11) {
      this.gatewayConnected = true
    }

    if (message.t === 'READY') {
      this.gatewayConnected = true
      logger.success('[discord-ws] Gateway READY')
    }

    if (message.t !== 'MESSAGE_CREATE') return

    void this.handleMessageCreate(message.d)
  }

  private async handleMessageCreate(
    data: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!data || data.channel_id !== this.options.channelId) return

    const content = String(data.content ?? '')
    const timestamp = String(data.timestamp ?? '')
    const note = parseMomoNote(content, timestamp)
    if (!note) return

    this.lastMessageAt = Date.now()

    const { enqueued } = outbox.enqueue(note)
    if (enqueued) {
      logger.info('[discord-ws] 已入队 outbox', note.key)
    } else {
      logger.info('[discord-ws] outbox 已存在，跳过', note.key)
    }
  }
}
