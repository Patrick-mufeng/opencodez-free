/**
 * A bounded in-memory log buffer behind the panel's 运行日志 page.
 *
 * The server keeps writing to stderr as before; this is a second sink the
 * panel can read. Capacity is fixed so a long-running process cannot grow
 * without bound.
 */

export type LogChannel = 'task' | 'chat' | 'sys'

export interface LogEntry {
  /** Monotonic sequence, so the panel can detect gaps and order entries. */
  seq: number
  time: string
  level: 'error' | 'warn' | 'info' | 'debug'
  channel: LogChannel
  message: string
  extra?: Record<string, unknown>
}

/** Whether a level is worth showing in the panel's ring. */
function wanted(level: LogEntry['level']): boolean {
  return level === 'error' || level === 'warn' || level === 'info'
}

export class LogRing {
  readonly #capacity: number
  #entries: LogEntry[] = []
  #seq = 0

  constructor(capacity = 500) {
    this.#capacity = Math.max(1, capacity)
  }

  push(level: LogEntry['level'], message: string, options: { channel?: LogChannel; extra?: Record<string, unknown> } = {}): void {
    if (!wanted(level)) return
    this.#entries.push({
      seq: this.#seq++,
      time: new Date().toISOString(),
      level,
      channel: options.channel ?? 'sys',
      message,
      ...(options.extra && Object.keys(options.extra).length > 0 ? { extra: options.extra } : {}),
    })
    if (this.#entries.length > this.#capacity) {
      this.#entries = this.#entries.slice(this.#entries.length - this.#capacity)
    }
  }

  /**
   * Recent entries, oldest first. `since` returns only entries newer than the
   * given sequence, which lets the panel poll incrementally.
   */
  list(options: { channel?: LogChannel | 'all'; limit?: number; since?: number } = {}): LogEntry[] {
    let entries = this.#entries
    if (options.since !== undefined) entries = entries.filter((entry) => entry.seq > options.since!)
    if (options.channel && options.channel !== 'all') entries = entries.filter((entry) => entry.channel === options.channel)
    const limit = options.limit ?? entries.length
    return limit >= entries.length ? [...entries] : entries.slice(entries.length - limit)
  }

  get lastSeq(): number {
    return this.#seq - 1
  }

  get size(): number {
    return this.#entries.length
  }

  clear(): void {
    this.#entries = []
  }
}

/**
 * Classify a log record's channel. Chat traffic and model probes are 'chat',
 * scheduled/background work is 'task', everything else is 'sys' — the same
 * three-way split the panel's filter chips expose.
 */
export function classifyChannel(message: string, extra?: Record<string, unknown>): LogChannel {
  if (extra?.model !== undefined) return 'chat'
  if (/^(GET|POST) \/v1\/(chat\/completions|responses|models)/.test(message)) return 'chat'
  if (/^(probe|scan|refresh|scheduler)/i.test(message)) return 'task'
  if (/\/panel\/api\/(probe|tasks|models\/scan)/.test(message)) return 'task'
  return 'sys'
}
