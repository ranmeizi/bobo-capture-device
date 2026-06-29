const { logger } = require('cdp-client-tool')
const outbox = require('./outbox')
const { pushMomoNotes } = require('./momo-message')

const TICK_MS = 5_000

let timer = null
let running = false

function isPushSuccess(res) {
  return res?.code === '000000'
}

async function pushRecord(record, { force = false } = {}) {
  if (!force && record.nextRetryAt > Date.now()) {
    return { skipped: true, reason: 'not_due' }
  }

  try {
    const res = await pushMomoNotes([record.note])
    if (isPushSuccess(res)) {
      outbox.markSent(record.key)
      logger.success('[outbox] push 成功', record.key)
      return { ok: true }
    }

    const err = `push 非成功: ${JSON.stringify(res)}`
    outbox.markFailed(record.key, err)
    logger.warn('[outbox] push 失败，已排期重试', record.key, err)
    return { ok: false, error: err }
  } catch (error) {
    outbox.markFailed(record.key, error)
    logger.warn('[outbox] push 异常，已排期重试', record.key, error)
    return { ok: false, error }
  }
}

async function flushDue({ force = false } = {}) {
  if (running) return { skipped: true, reason: 'busy' }
  running = true

  try {
    const due = outbox.getDueRecords(force)
    if (!due.length) {
      return { processed: 0, success: 0, failed: 0 }
    }

    let success = 0
    let failed = 0

    for (const record of due) {
      const result = await pushRecord(record, { force })
      if (result.skipped) continue
      if (result.ok) success++
      else failed++
    }

    return { processed: due.length, success, failed }
  } finally {
    running = false
  }
}

function startOutboxWorker() {
  if (timer) return

  logger.info('[outbox] worker 已启动', outbox.getStats())

  timer = setInterval(() => {
    void flushDue()
  }, TICK_MS)

  void flushDue()
}

function stopOutboxWorker() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

module.exports = {
  startOutboxWorker,
  stopOutboxWorker,
  flushDue,
  pushRecord,
}
