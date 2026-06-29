#!/usr/bin/env node
/**
 * Outbox 手动重报
 *
 * node scripts/outbox-retry.js stats
 * node scripts/outbox-retry.js list
 * node scripts/outbox-retry.js reset              # 全部重置为立即可重试
 * node scripts/outbox-retry.js reset --key <key>
 * node scripts/outbox-retry.js push               # 强制上报全部 pending（忽略退避时间）
 * node scripts/outbox-retry.js push --key <key>
 */
const outbox = require('../libs/outbox')
const { flushDue } = require('../libs/outbox-worker')

function parseArgs(argv) {
  const args = [...argv]
  const cmd = args.shift() || 'stats'
  let key = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) {
      key = args[i + 1]
      break
    }
  }

  return { cmd, key }
}

function formatRecord(r) {
  const due = r.nextRetryAt <= Date.now()
  return {
    key: r.key,
    attempts: r.attempts,
    due,
    nextRetryAt: new Date(r.nextRetryAt).toISOString(),
    createdAt: new Date(r.createdAt).toISOString(),
    lastError: r.lastError,
    subject: r.note?.subject,
    object: r.note?.object,
  }
}

async function main() {
  const { cmd, key } = parseArgs(process.argv.slice(2))

  switch (cmd) {
    case 'stats': {
      console.log(outbox.getStats())
      break
    }

    case 'list': {
      const pending = outbox.loadPending()
      if (!pending.length) {
        console.log('pending 为空')
        break
      }
      console.log(JSON.stringify(pending.map(formatRecord), null, 2))
      break
    }

    case 'reset': {
      if (key) {
        const ok = outbox.resetRetry(key)
        console.log(ok ? `已重置: ${key}` : `未找到: ${key}`)
      } else {
        const n = outbox.resetAllRetries()
        console.log(`已重置 ${n} 条为立即可重试`)
      }
      break
    }

    case 'push': {
      if (key) {
        outbox.resetRetry(key)
        const record = outbox.loadPending().find((r) => r.key === key)
        if (!record) {
          console.error(`未找到 pending: ${key}`)
          process.exit(1)
        }
        const { pushRecord } = require('../libs/outbox-worker')
        const result = await pushRecord(record, { force: true })
        console.log(result)
        process.exit(result.ok ? 0 : 1)
      }

      const result = await flushDue({ force: true })
      console.log(result)
      process.exit(result.failed ? 1 : 0)
      break
    }

    default:
      console.error(`未知命令: ${cmd}`)
      console.error('用法: stats | list | reset [--key] | push [--key]')
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
