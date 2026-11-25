import { execFile } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'
import axios from 'axios'
import * as Sentry from '@sentry/node'

if (!Sentry.getClient()) {
  Sentry.init({
    dsn: 'https://fe0a021f98c17d74554f87a6a133e817@o4512451653009408.ingest.us.sentry.io/4512463576760320',
    environment: process.env.NODE_ENV || 'development',
    serverName: 'bobo-cap',
  })
}

const API = process.env.CLASH_API ?? 'http://127.0.0.1:9090'
const INTERVAL_MS = Number(process.env.CLASH_INTERVAL_MS ?? 60_000)
const ENTRY = process.env.CLASH_GROUP ?? '🔰 手动选择'
const FALLBACK_ENTRY = '♻️ 自动选择'
const DELAY_URL = 'https://www.gstatic.com/generate_204'
const DELAY_TIMEOUT_MS = 5000
const SLOW_MS = 1500
const HISTORY_MAX_AGE_MS = 5 * 60_000
const STATUS_PORT = Number(process.env.CLASH_STATUS_PORT ?? 3939)
const STATUS_FILE = path.join(process.cwd(), 'logs/clash-status.json')
const SENTRY_INTERVAL_MS = 60 * 60_000

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance'])

type Proxy = {
  type?: string
  now?: string
  history?: { time?: string; delay?: number }[]
}

type ClashStatus = {
  ok: boolean
  updatedAt: string
  entry: string | null
  node: string | null
  nodeType: string | null
  delayMs: number | null
  direct: boolean
  error: string | null
}

let status: ClashStatus = {
  ok: false,
  updatedAt: new Date().toISOString(),
  entry: null,
  node: null,
  nodeType: null,
  delayMs: null,
  direct: false,
  error: '尚未采样',
}

function ensureForward(): Promise<void> {
  return new Promise((resolve) => {
    execFile('adb', ['forward', 'tcp:9090', 'tcp:9090'], () => resolve())
  })
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const res = await axios.get(API + pathname, {
    timeout: 12_000,
    validateStatus: () => true,
  })
  return { status: res.status, body: res.data }
}

function walk(
  proxies: Record<string, Proxy>,
  start: string,
): { name: string; node: Proxy } | null {
  let name = start
  const seen = new Set<string>()
  while (name && !seen.has(name)) {
    seen.add(name)
    const node = proxies[name]
    if (!node) return null
    if (!GROUP_TYPES.has(node.type ?? '') || !node.now) return { name, node }
    name = node.now
  }
  return null
}

function latestHistory(node: Proxy): { delay?: number; ageMs?: number } {
  const last = node.history?.[node.history.length - 1]
  if (!last || typeof last.delay !== 'number') return {}
  const parsed = last.time ? Date.parse(last.time) : NaN
  return {
    delay: last.delay,
    ageMs: Number.isNaN(parsed) ? undefined : Date.now() - parsed,
  }
}

function saveStatus(next: ClashStatus): void {
  status = next
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true })
    const tmp = `${STATUS_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, STATUS_FILE)
  } catch (err) {
    console.error('[clash] 写入状态失败', err)
  }
}

let lastSentryAt = 0

function reportLine(node: string, delayMs: number): void {
  const now = Date.now()
  if (now - lastSentryAt < SENTRY_INTERVAL_MS) return
  lastSentryAt = now
  Sentry.metrics.gauge('clash.delay', delayMs, {
    unit: 'millisecond',
    attributes: { node },
  })
  console.log(`[clash] sentry ${node} ${delayMs}ms`)
}

function page(): string {
  const delay =
    status.delayMs == null ? '无' : `${status.delayMs} ms`
  const state = status.direct ? '直连' : status.ok ? '正常' : '异常'
  return `<!doctype html>
<meta charset="utf-8">
<title>Clash</title>
<meta http-equiv="refresh" content="5">
<style>
  body { font: 16px/1.5 sans-serif; margin: 24px; background: #111; color: #eee; }
  b { font-size: 28px; }
</style>
<p>${state}</p>
<p>入口 <b>${status.entry ?? '-'}</b></p>
<p>节点 <b>${status.node ?? '-'}</b></p>
<p>延迟 <b>${delay}</b></p>
<p>更新 ${status.updatedAt}</p>
${status.error ? `<p>${status.error}</p>` : ''}
`
}

function startServer(): void {
  const server = http.createServer((req, res) => {
    const url = req.url?.split('?')[0]
    if (url === '/status.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(status))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page())
  })
  server.on('error', (err) => {
    console.error('[clash] 状态页监听失败', err)
  })
  server.listen(STATUS_PORT, '0.0.0.0', () => {
    console.log(`[clash] 状态页 http://0.0.0.0:${STATUS_PORT}`)
  })
}

async function tick(): Promise<void> {
  let res: { status: number; body: any }
  try {
    res = await getJson('/proxies')
  } catch {
    await ensureForward()
    try {
      res = await getJson('/proxies')
    } catch (err) {
      console.error('[clash] API 不可达', err)
      saveStatus({
        ...status,
        ok: false,
        updatedAt: new Date().toISOString(),
        error: 'API 不可达',
      })
      return
    }
  }

  const proxies = res.body?.proxies as Record<string, Proxy> | undefined
  if (res.status !== 200 || !proxies) {
    console.error('[clash] /proxies 异常', res.status)
    saveStatus({
      ...status,
      ok: false,
      updatedAt: new Date().toISOString(),
      error: `/proxies ${res.status}`,
    })
    return
  }

  const entry = proxies[ENTRY] ? ENTRY : FALLBACK_ENTRY
  const leaf = walk(proxies, entry)
  if (!leaf) {
    console.error('[clash] 找不到出口', entry)
    saveStatus({
      ok: false,
      updatedAt: new Date().toISOString(),
      entry,
      node: null,
      nodeType: null,
      delayMs: null,
      direct: false,
      error: '找不到出口',
    })
    return
  }
  if (leaf.node.type === 'Direct' || leaf.name === 'DIRECT') {
    console.warn(`[clash] ${entry} 当前走直连`)
    saveStatus({
      ok: false,
      updatedAt: new Date().toISOString(),
      entry,
      node: leaf.name,
      nodeType: leaf.node.type ?? 'Direct',
      delayMs: null,
      direct: true,
      error: null,
    })
    return
  }

  let { delay, ageMs } = latestHistory(leaf.node)
  const stale = delay == null || (ageMs != null && ageMs > HISTORY_MAX_AGE_MS)
  let error: string | null = null
  if (stale) {
    const pathname =
      `/proxies/${encodeURIComponent(leaf.name)}/delay` +
      `?url=${encodeURIComponent(DELAY_URL)}&timeout=${DELAY_TIMEOUT_MS}`
    try {
      const measured = await getJson(pathname)
      if (measured.status === 200 && typeof measured.body?.delay === 'number') {
        delay = measured.body.delay
      } else {
        error = `测速失败 ${measured.status}`
        console.warn('[clash] 测速失败', leaf.name, measured.status, measured.body)
      }
    } catch (err) {
      error = '测速失败'
      console.warn('[clash] 测速失败', leaf.name, err)
    }
  }

  if (delay != null) reportLine(leaf.name, delay)

  const line = `[clash] ${entry} -> ${leaf.name} delay=${delay ?? 'na'}ms`
  if (delay != null && delay >= SLOW_MS) console.warn(line)
  else console.log(line)

  saveStatus({
    ok: delay != null && delay < SLOW_MS,
    updatedAt: new Date().toISOString(),
    entry,
    node: leaf.name,
    nodeType: leaf.node.type ?? null,
    delayMs: delay ?? null,
    direct: false,
    error,
  })
}

startServer()

void tick()
setInterval(() => {
  void tick()
}, INTERVAL_MS)
