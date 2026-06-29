const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_DIR = path.join(process.cwd(), 'data/outbox')
const PENDING_FILE = 'pending.jsonl'

const BASE_RETRY_MS = 5_000
const MAX_RETRY_MS = 15 * 60 * 1000

function getOutboxDir() {
  return process.env.OUTBOX_DIR || DEFAULT_DIR
}

function getPendingPath() {
  return path.join(getOutboxDir(), PENDING_FILE)
}

function ensureDir() {
  fs.mkdirSync(getOutboxDir(), { recursive: true })
}

function parseLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  return JSON.parse(trimmed)
}

function loadPending() {
  ensureDir()
  const filePath = getPendingPath()
  if (!fs.existsSync(filePath)) return []

  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  const records = []
  const seen = new Set()

  for (const line of lines) {
    try {
      const record = parseLine(line)
      if (!record?.key) continue
      if (seen.has(record.key)) continue
      seen.add(record.key)
      records.push(normalizeRecord(record))
    } catch {
      // 跳过损坏行
    }
  }

  return records
}

function normalizeRecord(record) {
  return {
    key: record.key,
    note: record.note,
    attempts: record.attempts ?? 0,
    nextRetryAt: record.nextRetryAt ?? 0,
    createdAt: record.createdAt ?? Date.now(),
    lastError: record.lastError ?? null,
  }
}

function savePending(records) {
  ensureDir()
  const filePath = getPendingPath()
  const content = records.map((r) => JSON.stringify(r)).join('\n')
  fs.writeFileSync(filePath, content ? `${content}\n` : '', 'utf8')
}

function calcNextRetryAt(attempts) {
  const delay = Math.min(BASE_RETRY_MS * 2 ** attempts, MAX_RETRY_MS)
  return Date.now() + delay
}

/**
 * @param {object} note
 * @returns {{ enqueued: boolean, key: string }}
 */
function enqueue(note) {
  if (!note?.key) {
    throw new Error('note.key 不能为空')
  }

  const pending = loadPending()
  if (pending.some((r) => r.key === note.key)) {
    return { enqueued: false, key: note.key }
  }

  pending.push({
    key: note.key,
    note,
    attempts: 0,
    nextRetryAt: 0,
    createdAt: Date.now(),
    lastError: null,
  })

  savePending(pending)
  return { enqueued: true, key: note.key }
}

function removeByKey(key) {
  const pending = loadPending().filter((r) => r.key !== key)
  savePending(pending)
}

function markSent(key) {
  removeByKey(key)
  appendSent(key)
}

function appendSent(key) {
  ensureDir()
  const sentPath = path.join(getOutboxDir(), 'sent.jsonl')
  fs.appendFileSync(
    sentPath,
    `${JSON.stringify({ key, sentAt: Date.now() })}\n`,
    'utf8',
  )
}

function markFailed(key, error) {
  const pending = loadPending()
  const record = pending.find((r) => r.key === key)
  if (!record) return null

  record.attempts += 1
  record.nextRetryAt = calcNextRetryAt(record.attempts)
  record.lastError = String(error?.message ?? error ?? 'unknown')

  savePending(pending)
  return record
}

/** 手动：立即重试（忽略 nextRetryAt） */
function resetRetry(key) {
  const pending = loadPending()
  const record = pending.find((r) => r.key === key)
  if (!record) return false

  record.nextRetryAt = 0
  record.lastError = null
  savePending(pending)
  return true
}

/** 手动：全部重置为立即可重试 */
function resetAllRetries() {
  const pending = loadPending()
  if (!pending.length) return 0

  for (const record of pending) {
    record.nextRetryAt = 0
    record.lastError = null
  }
  savePending(pending)
  return pending.length
}

function getDueRecords(ignoreSchedule = false) {
  const now = Date.now()
  return loadPending().filter(
    (r) => ignoreSchedule || r.nextRetryAt <= now,
  )
}

function getStats() {
  const pending = loadPending()
  const now = Date.now()
  return {
    total: pending.length,
    due: pending.filter((r) => r.nextRetryAt <= now).length,
    waiting: pending.filter((r) => r.nextRetryAt > now).length,
    dir: getOutboxDir(),
  }
}

module.exports = {
  enqueue,
  loadPending,
  markSent,
  markFailed,
  resetRetry,
  resetAllRetries,
  getDueRecords,
  getStats,
  getOutboxDir,
  calcNextRetryAt,
  BASE_RETRY_MS,
  MAX_RETRY_MS,
}
