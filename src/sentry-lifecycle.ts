import * as Sentry from '@sentry/node'

type Extra = Record<string, string | number | boolean | undefined>

/** 与 process start 事件对齐，退出时记在事件上，方便对照。 */
const processStartedAt = Date.now()

function report(
  message: string,
  phase: string,
  level: 'info' | 'warning' | 'error',
  extra: Extra,
): void {
  Sentry.withScope((scope) => {
    scope.setLevel(level)
    scope.setTag('service', 'bobo-cap')
    scope.setTag('phase', phase)
    scope.setFingerprint(['bobo-cap', phase])
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) scope.setExtra(key, value)
    }
    Sentry.captureMessage(message, level)
  })
}

/** 进程已进入启动流程。之后若没有 ws connected，说明网关还没就绪。 */
export function reportProcessStart(): void {
  report('bobo-cap process start', 'process_start', 'info', {
    pid: process.pid,
  })
}

export function reportProcessStartFailed(err: unknown): void {
  report('bobo-cap process start failed', 'process_start_failed', 'error', {
    pid: process.pid,
    error: err instanceof Error ? err.message : String(err),
  })
}

/** 进程即将退出。这是健康时间线里的终止事件。 */
export function reportProcessExit(reason: string, exitCode: number): void {
  const uptimeMs = Date.now() - processStartedAt
  report(
    'bobo-cap process exit',
    'process_exit',
    exitCode === 0 ? 'info' : 'error',
    {
      pid: process.pid,
      reason,
      exitCode,
      uptimeMs,
    },
  )
}

/** Gateway 会话 READY，可以收消息。 */
export function reportWsConnected(signal: string): void {
  report('bobo-cap ws connected', 'ws_connected', 'info', {
    pid: process.pid,
    signal,
  })
}

export function reportWsDisconnected(opts: {
  reason: string
  connectedMs?: number
  wasReady: boolean
}): void {
  report('bobo-cap ws disconnected', 'ws_disconnected', 'warning', {
    pid: process.pid,
    reason: opts.reason,
    connectedMs: opts.connectedMs,
    wasReady: opts.wasReady,
  })
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs)
  } catch {
    // 退出路径上不再抛
  }
}
