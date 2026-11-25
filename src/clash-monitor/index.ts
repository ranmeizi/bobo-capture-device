import { execFile } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
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
const ENTRY = process.env.CLASH_GROUP ?? '🔰 手动选择'
const FALLBACK_ENTRY = '♻️ 自动选择'
const DELAY_URL = 'https://www.gstatic.com/generate_204'
const DELAY_TIMEOUT_MS = 5000
const SLOW_MS = 1500
const HISTORY_MAX_AGE_MS = 5 * 60_000
const STATUS_PORT = Number(process.env.CLASH_STATUS_PORT ?? 3939)
const STATUS_FILE = path.join(process.cwd(), 'logs/clash-status.json')
const SENTRY_INTERVAL_MS = 60 * 60_000
const GROUP_TEST_TIMEOUT_MS = 90_000

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance'])

type Proxy = {
  type?: string
  now?: string
  all?: string[]
  history?: { time?: string; delay?: number }[]
}

type NodeRow = {
  name: string
  type: string | null
  delayMs: number | null
  selected: boolean
}

type ClashStatus = {
  ok: boolean
  updatedAt: string
  entry: string | null
  selected: string | null
  switchable: boolean
  node: string | null
  nodeType: string | null
  delayMs: number | null
  direct: boolean
  testing: boolean
  error: string | null
  nodes: NodeRow[]
}

let status: ClashStatus = {
  ok: false,
  updatedAt: new Date().toISOString(),
  entry: null,
  selected: null,
  switchable: false,
  node: null,
  nodeType: null,
  delayMs: null,
  direct: false,
  testing: false,
  error: '尚未采样',
  nodes: [],
}

let proxiesCache: Record<string, Proxy> | null = null
let testing = false
let lastLeafMeasureAt = 0
let chain: Promise<unknown> = Promise.resolve()
const collapsed = new Map<string, Promise<unknown>>()

function enqueue<T>(key: string | null, job: () => Promise<T>): Promise<T> {
  if (key) {
    const existing = collapsed.get(key)
    if (existing) return existing as Promise<T>
  }
  const run = chain.then(job, job)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  if (key) {
    collapsed.set(key, run)
    void run.finally(() => {
      if (collapsed.get(key) === run) collapsed.delete(key)
    })
  }
  return run
}

function refresh(): Promise<void> {
  return enqueue('refresh', () => tick())
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

function latestHistory(node: Proxy | undefined): { delay?: number; ageMs?: number } {
  const last = node?.history?.[node.history.length - 1]
  if (!last || typeof last.delay !== 'number') return {}
  const parsed = last.time ? Date.parse(last.time) : NaN
  return {
    delay: last.delay,
    ageMs: Number.isNaN(parsed) ? undefined : Date.now() - parsed,
  }
}

function entryOf(proxies: Record<string, Proxy>): string {
  return proxies[ENTRY] ? ENTRY : FALLBACK_ENTRY
}

function nodeRows(proxies: Record<string, Proxy>, entry: string): NodeRow[] {
  const group = proxies[entry]
  const selected = group?.now ?? null
  return (group?.all ?? []).map((name) => {
    const node = proxies[name]
    const { delay } = latestHistory(node)
    return {
      name,
      type: node?.type ?? null,
      delayMs: typeof delay === 'number' ? delay : null,
      selected: name === selected,
    }
  })
}

function saveStatus(next: ClashStatus): void {
  status = { ...next, testing }
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true })
    const tmp = `${STATUS_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2))
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

async function loadProxies(): Promise<Record<string, Proxy> | null> {
  let res: { status: number; body: any }
  try {
    res = await getJson('/proxies')
  } catch {
    await ensureForward()
    try {
      res = await getJson('/proxies')
    } catch (err) {
      console.error('[clash] API 不可达', err)
      saveStatus({ ...status, ok: false, updatedAt: new Date().toISOString(), error: 'API 不可达' })
      return null
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
    return null
  }
  proxiesCache = proxies
  return proxies
}

async function tick(): Promise<void> {
  const proxies = await loadProxies()
  if (!proxies) return

  const entry = entryOf(proxies)
  const group = proxies[entry]
  const nodes = nodeRows(proxies, entry)
  const selected = group?.now ?? null
  const switchable = group?.type === 'Selector'
  const leaf = walk(proxies, entry)
  const base = {
    updatedAt: new Date().toISOString(),
    entry,
    selected,
    switchable,
    nodes,
  }

  if (!leaf) {
    console.error('[clash] 找不到出口', entry)
    saveStatus({
      ...status,
      ...base,
      ok: false,
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
      ...status,
      ...base,
      ok: false,
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
  const due = Date.now() - lastLeafMeasureAt >= HISTORY_MAX_AGE_MS
  let error: string | null = null
  if (stale && due && !testing) {
    const pathname =
      `/proxies/${encodeURIComponent(leaf.name)}/delay` +
      `?url=${encodeURIComponent(DELAY_URL)}&timeout=${DELAY_TIMEOUT_MS}`
    try {
      lastLeafMeasureAt = Date.now()
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

  if (delay != null && delay > 0) reportLine(leaf.name, delay)

  saveStatus({
    ...base,
    ok: delay != null && delay > 0 && delay < SLOW_MS,
    node: leaf.name,
    nodeType: leaf.node.type ?? null,
    delayMs: delay ?? null,
    direct: false,
    error,
    testing,
  })
}

function applyDelays(delays: Record<string, number>): void {
  status = {
    ...status,
    nodes: status.nodes.map((row) => {
      const delay = delays[row.name]
      return typeof delay === 'number' ? { ...row, delayMs: delay } : row
    }),
    updatedAt: new Date().toISOString(),
  }
  saveStatus(status)
}

async function testAll(): Promise<string | null> {
  if (testing) return null
  const proxies = proxiesCache ?? (await loadProxies())
  if (!proxies) return 'API 不可达'
  const entry = entryOf(proxies)
  const names = proxies[entry]?.all ?? []
  testing = true
  saveStatus({ ...status, error: null })
  try {
    const pathname =
      `/group/${encodeURIComponent(entry)}/delay` +
      `?url=${encodeURIComponent(DELAY_URL)}&timeout=${DELAY_TIMEOUT_MS}`
    const measured = await axios.get(API + pathname, {
      timeout: GROUP_TEST_TIMEOUT_MS,
      validateStatus: () => true,
    })
    if (measured.status === 200 && measured.data && typeof measured.data === 'object') {
      applyDelays(measured.data as Record<string, number>)
      console.log('[clash] 全组测速完成', entry)
      return null
    }
    console.warn('[clash] 全组测速接口不可用，改为逐个测', measured.status)
    const delays: Record<string, number> = {}
    let cursor = 0
    async function worker(): Promise<void> {
      while (cursor < names.length) {
        const name = names[cursor++]
        const one =
          `/proxies/${encodeURIComponent(name)}/delay` +
          `?url=${encodeURIComponent(DELAY_URL)}&timeout=${DELAY_TIMEOUT_MS}`
        try {
          const res = await getJson(one)
          if (res.status === 200 && typeof res.body?.delay === 'number') {
            delays[name] = res.body.delay
          }
        } catch {
          // 单个节点失败留空，继续测后面的
        }
      }
    }
    if (names.length > 0) await worker()
    applyDelays(delays)
    return null
  } catch (err) {
    console.warn('[clash] 全组测速失败', err)
    saveStatus({ ...status, error: '测速失败' })
    return '测速失败'
  } finally {
    testing = false
    await tick()
  }
}

async function switchTo(name: string): Promise<string | null> {
  const proxies = proxiesCache ?? (await loadProxies())
  if (!proxies) return 'API 不可达'
  const entry = entryOf(proxies)
  const group = proxies[entry]
  if (group?.type !== 'Selector') return '当前组不是手动选择，不能切换'
  if (group.all && !group.all.includes(name)) return '节点不在该组里'
  const res = await axios.put(
    `${API}/proxies/${encodeURIComponent(entry)}`,
    { name },
    { timeout: 8_000, validateStatus: () => true },
  )
  if (res.status !== 204 && res.status !== 200) {
    console.warn('[clash] 切换失败', entry, name, res.status, res.data)
    return `切换失败 ${res.status}`
  }
  console.log(`[clash] 切换 ${entry} -> ${name}`)
  await tick()
  return null
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).length > 8192) req.destroy()
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function page(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clash</title>
<style>
  body { margin: 0; background: #111; color: #eee; font: 15px/1.4 sans-serif; }
  header { position: sticky; top: 0; background: #111; padding: 16px 16px 8px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 4px 0; color: #bbb; }
  button { font: inherit; color: inherit; background: #222; border: 1px solid #333; border-radius: 10px; }
  #test { padding: 8px 14px; margin: 10px 0; }
  #list { display: flex; flex-direction: column; gap: 8px; padding: 8px 16px 24px; }
  .node { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 12px 14px; }
  .node.selected { border-color: #3dd68c; background: #163226; }
  .node:disabled { opacity: 0.7; }
  .name { flex: 1; }
  .type { color: #888; font-size: 12px; }
  .delay { font-variant-numeric: tabular-nums; }
  .bad { color: #f07178; }
  .slow { color: #e6b450; }
</style>
<header>
  <h1>Clash</h1>
  <p id="summary">读取中</p>
  <button id="test" type="button">全部测速</button>
</header>
<div id="list"></div>
<script>
const summary = document.getElementById('summary')
const list = document.getElementById('list')
const testBtn = document.getElementById('test')

function delayText(ms) {
  if (ms == null) return '—'
  if (ms <= 0) return '超时'
  return ms + ' ms'
}

function render(s) {
  const exitDelay = s.delayMs == null ? '无' : delayText(s.delayMs)
  const state = s.direct ? '直连' : s.ok ? '正常' : '异常'
  summary.textContent = [
    state,
    '选择 ' + (s.selected || '-'),
    '出口 ' + (s.node || '-'),
    exitDelay,
    s.error || '',
  ].filter(Boolean).join(' · ')
  testBtn.disabled = !!s.testing
  testBtn.textContent = s.testing ? '测速中' : '全部测速'
  list.replaceChildren()
  for (const row of s.nodes || []) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'node' + (row.selected ? ' selected' : '')
    btn.disabled = !s.switchable
    btn.dataset.name = row.name
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = row.name
    const meta = document.createElement('span')
    const type = document.createElement('div')
    type.className = 'type'
    type.textContent = row.type || ''
    const delay = document.createElement('div')
    delay.className = 'delay' + (row.delayMs === 0 ? ' bad' : row.delayMs >= ${SLOW_MS} ? ' slow' : '')
    delay.textContent = delayText(row.delayMs)
    meta.append(type, delay)
    btn.append(name, meta)
    list.append(btn)
  }
}

const PULL_MS = 5000
let chain = Promise.resolve()
let refreshing = null

function enqueueClient(task) {
  const run = chain.then(task, task)
  chain = run.then(() => {}, () => {})
  return run
}

function refresh() {
  if (refreshing) return refreshing
  refreshing = enqueueClient(async () => {
    const res = await fetch('/refresh', { method: 'POST' })
    const body = await res.json()
    render(body.status || body)
  }).finally(() => { refreshing = null })
  return refreshing
}

let testingReq = null
testBtn.onclick = () => {
  if (testingReq) return testingReq
  testingReq = enqueueClient(async () => {
    testBtn.disabled = true
    testBtn.textContent = '测速中'
    const res = await fetch('/test', { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (body.status) render(body.status)
    if (!res.ok || body.ok === false) summary.textContent = body.error || '测速失败'
  }).finally(() => { testingReq = null })
  return testingReq
}

list.onclick = (event) => {
  const btn = event.target.closest('.node')
  if (!btn || btn.disabled) return
  const target = btn.dataset.name
  return enqueueClient(async () => {
    summary.textContent = '正在切换 ' + target
    const res = await fetch('/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: target }),
    })
    const body = await res.json().catch(() => ({}))
    if (body.status) render(body.status)
    if (!res.ok || body.ok === false) summary.textContent = body.error || '切换失败'
  })
}

refresh()
setInterval(() => { refresh().catch(() => {}) }, PULL_MS)
</script>
`
}

function startServer(): void {
  const server = http.createServer((req, res) => {
    void handle(req, res)
  })
  server.on('error', (err) => {
    console.error('[clash] 状态页监听失败', err)
  })
  server.listen(STATUS_PORT, '0.0.0.0', () => {
    console.log(`[clash] 状态页 http://0.0.0.0:${STATUS_PORT}`)
  })
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url?.split('?')[0]
  try {
    if (req.method === 'GET' && url === '/status.json') {
      sendJson(res, 200, status)
      return
    }
    if (req.method === 'POST' && url === '/refresh') {
      await refresh()
      sendJson(res, 200, { ok: !status.error, error: status.error, status })
      return
    }
    if (req.method === 'POST' && url === '/test') {
      const error = await enqueue(null, () => testAll())
      sendJson(res, error ? 502 : 200, { ok: !error, error, status })
      return
    }
    if (req.method === 'POST' && url === '/switch') {
      const raw = await readBody(req)
      let name = ''
      try {
        name = String(JSON.parse(raw || '{}').name ?? '')
      } catch {
        name = ''
      }
      if (!name) {
        sendJson(res, 400, { ok: false, error: '缺少节点名' })
        return
      }
      const error = await enqueue(null, async () => {
        const err = await switchTo(name)
        if (err) saveStatus({ ...status, error: err })
        return err
      })
      sendJson(res, error ? 400 : 200, { ok: !error, error, status })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page())
  } catch (err) {
    console.error('[clash] 请求失败', err)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '请求失败' })
  }
}

startServer()

void refresh()
setInterval(() => {
  void refresh()
}, SENTRY_INTERVAL_MS)
