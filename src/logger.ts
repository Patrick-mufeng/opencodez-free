import type { LogFn } from './server.ts'
import type { ServiceConfig } from './config.ts'
import { classifyChannel, type LogRing } from './logring.ts'

/**
 * Minimal leveled logger. Human-readable lines on stderr, and a copy into the
 * in-memory ring the panel reads.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const

const COLORS: Record<string, string> = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
}
const RESET = '\u001b[0m'

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR !== undefined) return true
  return process.stdout.isTTY === true
}

export function createLogger(config: Pick<ServiceConfig, 'logLevel'>, ring?: LogRing): LogFn {
  const threshold = LEVELS[config.logLevel]
  const color = useColor()

  return (level, message, extra) => {
    // The ring keeps a record regardless of the console threshold, so the
    // panel still has history when the terminal is set to silent.
    if (ring && level !== 'debug') {
      const { channel: explicitChannel, ...rest } = (extra ?? {}) as { channel?: 'task' | 'chat' | 'sys' } & Record<string, unknown>
      ring.push(level, message, {
        channel: explicitChannel ?? classifyChannel(message, rest),
        ...(Object.keys(rest).length > 0 ? { extra: rest } : {}),
      })
    }
    if (LEVELS[level] > threshold) return
    const stamp = new Date().toISOString().slice(11, 23)
    const tag = level.toUpperCase().padEnd(5)
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : ''
    const line = `${stamp} ${tag} ${message}${suffix}`
    const rendered = color ? `${COLORS[level] ?? ''}${line}${RESET}` : line
    process.stderr.write(rendered + '\n')
  }
}
