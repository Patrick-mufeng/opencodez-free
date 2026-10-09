import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Usage accounting: per-day buckets keyed by natural day (local time), plus
 * lifetime totals that never shrink with the retention window.
 *
 * Mirrors workbuddy-free's stats module: the panel's "lifetime" headline and
 * its "range" figures come from two different sources on purpose — the first
 * is cumulative and never loses history, the second obeys `keepDays`. Keeping
 * them separate is what makes the panel's two readouts always self-consistent.
 */

/** One day (or hour) of usage. */
export interface StatPoint {
  /** `YYYY-MM-DD` for days, `YYYY-MM-DDTHH` for hours. */
  key: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  requests: number
  failed: number
  /** Wall-clock ms of completed requests, for the average-rate readout. */
  duration_ms: number
}

export interface LifetimeTotals {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  requests: number
  failed: number
  duration_ms: number
  /** First request ever recorded. */
  since: string | null
}

/** Per-model rollup inside a range. */
export interface ModelRollup {
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  requests: number
  failed: number
}

export interface StatsSnapshot {
  range: string
  /** Bucket resolution; the panel labels its axis from this. */
  unit: 'day' | 'hour'
  from: string
  to: string
  points: StatPoint[]
  totals: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    requests: number
    failed: number
    avg_rate: number
  }
  models: ModelRollup[]
}

export type RangeKey = 'today' | '7d' | '30d' | 'all'

export interface StatsOptions {
  /** Persistence path; omit for an in-memory collector (tests). */
  path?: string
  /** Days of detail kept on disk. Lifetime totals survive regardless. */
  keepDays?: number
  now?: () => number
  /** Writes are debounced by this much to avoid hammering the disk. */
  flushDelayMs?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Local-time `YYYY-MM-DD`, matching what the panel displays. */
export function dayKey(time: number | Date): string {
  const date = time instanceof Date ? time : new Date(time)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Local-time `YYYY-MM-DDTHH`, used by the "today" range. */
export function hourKey(time: number | Date): string {
  const date = time instanceof Date ? time : new Date(time)
  return `${dayKey(date)}T${String(date.getHours()).padStart(2, '0')}`
}

interface Persisted {
  version: 1
  lifetime: LifetimeTotals
  days: StatPoint[]
  /** Per-day per-model detail, so model rollups respect the range window. */
  models: Record<string, Record<string, ModelRollup>>
  /** Per-hour detail for today's view, keyed by hour. */
  hours: Record<string, { points: StatPoint[]; models: Record<string, ModelRollup> }>
  updatedAt: number
}

/** One completed request, as the server reports it. */
export interface UsageRecord {
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  durationMs: number
  failed: boolean
  /** Epoch ms; defaults to now. */
  at?: number
}

function emptyPoint(key: string): StatPoint {
  return { key, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, failed: 0, duration_ms: 0 }
}

function emptyRollup(model: string): ModelRollup {
  return { model, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, failed: 0 }
}

function emptyLifetime(): LifetimeTotals {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, failed: 0, duration_ms: 0, since: null }
}

export class StatsStore {
  #lifetime: LifetimeTotals = emptyLifetime()
  #days = new Map<string, StatPoint>()
  #dayModels = new Map<string, Map<string, ModelRollup>>()
  #hours = new Map<string, { point: StatPoint; models: Map<string, ModelRollup> }>()
  #updatedAt = 0
  readonly #options: StatsOptions
  #flushTimer: NodeJS.Timeout | null = null
  #dirty = false
  #loaded = false
  #flushPromise: Promise<void> | null = null

  constructor(options: StatsOptions = {}) {
    this.#options = options
  }

  get #now(): () => number {
    return this.#options.now ?? Date.now
  }

  get keepDays(): number {
    return this.#options.keepDays ?? 30
  }

  /** Load persisted state. A missing or unreadable file starts empty. */
  async load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    if (!this.#options.path) return
    try {
      const raw = JSON.parse(await readFile(this.#options.path, 'utf8')) as Persisted
      if (raw.version !== 1) return
      this.#lifetime = { ...emptyLifetime(), ...raw.lifetime }
      for (const point of raw.days ?? []) {
        if (point?.key) this.#days.set(point.key, { ...emptyPoint(point.key), ...point })
      }
      for (const [day, models] of Object.entries(raw.models ?? {})) {
        const bucket = new Map<string, ModelRollup>()
        for (const [model, rollup] of Object.entries(models ?? {})) bucket.set(model, { ...emptyRollup(model), ...rollup })
        this.#dayModels.set(day, bucket)
      }
      for (const [hour, entry] of Object.entries(raw.hours ?? {})) {
        if (!entry?.points?.length) continue
        const point = { ...emptyPoint(hour), ...entry.points[0] }
        const models = new Map<string, ModelRollup>()
        for (const [model, rollup] of Object.entries(entry.models ?? {})) models.set(model, { ...emptyRollup(model), ...rollup })
        this.#hours.set(hour, { point, models })
      }
      this.#updatedAt = raw.updatedAt ?? 0
    } catch {
      // No usable history: start fresh rather than fail startup.
    }
  }

  /** Record one finished request. */
  record(usage: UsageRecord): void {
    const at = usage.at ?? this.#now()
    const day = dayKey(at)
    const hour = hourKey(at)
    const failed = usage.failed ? 1 : 0
    const requests = 1

    const lifetime = this.#lifetime
    lifetime.prompt_tokens += usage.prompt_tokens
    lifetime.completion_tokens += usage.completion_tokens
    lifetime.total_tokens += usage.total_tokens
    lifetime.requests += requests
    lifetime.failed += failed
    lifetime.duration_ms += usage.durationMs
    if (lifetime.since === null) lifetime.since = new Date(at).toISOString()

    this.#addTo(this.#dayPoint(day), usage, failed, requests)
    this.#addRollup(this.#dayModelsFor(day), usage, failed, requests)

    const hourEntry = this.#hourEntry(hour)
    this.#addTo(hourEntry.point, usage, failed, requests)
    this.#addRollup(hourEntry.models, usage, failed, requests)

    this.#updatedAt = at
    this.#prune()
    this.#dirty = true
    this.#scheduleFlush()
  }

  #addTo(point: StatPoint, usage: UsageRecord, failed: number, requests: number): void {
    point.prompt_tokens += usage.prompt_tokens
    point.completion_tokens += usage.completion_tokens
    point.total_tokens += usage.total_tokens
    point.requests += requests
    point.failed += failed
    point.duration_ms += usage.durationMs
  }

  #addRollup(bucket: Map<string, ModelRollup>, usage: UsageRecord, failed: number, requests: number): void {
    const model = usage.model.length > 0 ? usage.model : 'unknown'
    const rollup = bucket.get(model) ?? emptyRollup(model)
    rollup.prompt_tokens += usage.prompt_tokens
    rollup.completion_tokens += usage.completion_tokens
    rollup.total_tokens += usage.total_tokens
    rollup.requests += requests
    rollup.failed += failed
    bucket.set(model, rollup)
  }

  #dayPoint(day: string): StatPoint {
    const existing = this.#days.get(day)
    if (existing) return existing
    const created = emptyPoint(day)
    this.#days.set(day, created)
    return created
  }

  #dayModelsFor(day: string): Map<string, ModelRollup> {
    const existing = this.#dayModels.get(day)
    if (existing) return existing
    const created = new Map<string, ModelRollup>()
    this.#dayModels.set(day, created)
    return created
  }

  #hourEntry(hour: string): { point: StatPoint; models: Map<string, ModelRollup> } {
    const existing = this.#hours.get(hour)
    if (existing) return existing
    const created = { point: emptyPoint(hour), models: new Map<string, ModelRollup>() }
    this.#hours.set(hour, created)
    return created
  }

  /** Drop detail beyond the retention window; lifetime totals are untouched. */
  #prune(): void {
    const cutoff = dayKey(this.#now() - (this.keepDays - 1) * DAY_MS)
    for (const day of this.#days.keys()) {
      if (day < cutoff) {
        this.#days.delete(day)
        this.#dayModels.delete(day)
      }
    }
    const today = dayKey(this.#now())
    for (const hour of this.#hours.keys()) {
      if (!hour.startsWith(today)) this.#hours.delete(hour)
    }
  }

  #scheduleFlush(): void {
    if (!this.#options.path) return
    if (this.#flushTimer) return
    const delay = this.#options.flushDelayMs ?? 2000
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      void this.flush()
    }, delay)
    this.#flushTimer.unref?.()
  }

  /** Write the current state. Safe to call at any time. */
  async flush(): Promise<void> {
    if (!this.#options.path || !this.#dirty) return
    // Serialize overlapping flushes: two writers would race on the rename.
    if (this.#flushPromise) return this.#flushPromise
    const path = this.#options.path
    this.#dirty = false
    const payload: Persisted = {
      version: 1,
      lifetime: this.#lifetime,
      days: [...this.#days.values()].sort((a, b) => a.key.localeCompare(b.key)),
      models: Object.fromEntries([...this.#dayModels].map(([day, models]) => [day, Object.fromEntries(models)])),
      hours: Object.fromEntries(
        [...this.#hours].map(([hour, entry]) => [hour, { points: [entry.point], models: Object.fromEntries(entry.models) }]),
      ),
      updatedAt: this.#updatedAt,
    }
    this.#flushPromise = (async () => {
      try {
        const tmp = `${path}.${process.pid}.tmp`
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, JSON.stringify(payload), 'utf8')
        await rm(path, { force: true })
        await rename(tmp, path)
      } catch {
        // A failed write must not lose the in-memory numbers; mark dirty again
        // so the next flush retries.
        this.#dirty = true
      } finally {
        this.#flushPromise = null
      }
    })()
    return this.#flushPromise
  }

  /** Stop the flush timer, writing anything pending. */
  async close(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }
    await this.flush()
  }

  /** Lifetime totals plus the first recorded timestamp. */
  lifetime(): LifetimeTotals {
    return { ...this.#lifetime }
  }

  /**
   * A range window. `today` is served from hour buckets so the chart has a
   * useful resolution; the other ranges use day buckets.
   */
  snapshot(range: RangeKey = '30d'): StatsSnapshot {
    const now = this.#now()
    if (range === 'today') {
      const today = dayKey(now)
      const points: StatPoint[] = []
      const models = new Map<string, ModelRollup>()
      for (let hour = 0; hour < 24; hour++) {
        const key = `${today}T${String(hour).padStart(2, '0')}`
        const entry = this.#hours.get(key)
        points.push(entry ? { ...entry.point } : emptyPoint(key))
        if (entry) for (const rollup of entry.models.values()) mergeRollup(models, rollup)
      }
      return this.#assemble('today', today, today, points, models, 'hour')
    }

    const days = range === '7d' ? 7 : range === '30d' ? 30 : 0
    const from = days > 0 ? dayKey(now - (days - 1) * DAY_MS) : (this.#earliestDay() ?? dayKey(now))
    const to = dayKey(now)
    const points: StatPoint[] = []
    const models = new Map<string, ModelRollup>()
    // Walk every calendar day in range so gaps read as zero, not as missing.
    const startTime = new Date(`${from}T00:00:00`).getTime()
    const endTime = new Date(`${to}T00:00:00`).getTime()
    for (let time = startTime; time <= endTime; time += DAY_MS) {
      const key = dayKey(time)
      const point = this.#days.get(key)
      points.push(point ? { ...point } : emptyPoint(key))
      const bucket = this.#dayModels.get(key)
      if (bucket) for (const rollup of bucket.values()) mergeRollup(models, rollup)
    }
    return this.#assemble(range, from, to, points, models, 'day')
  }

  #earliestDay(): string | null {
    let earliest: string | null = null
    for (const day of this.#days.keys()) {
      if (earliest === null || day < earliest) earliest = day
    }
    return earliest
  }

  #assemble(
    range: string,
    from: string,
    to: string,
    points: StatPoint[],
    models: Map<string, ModelRollup>,
    unit: 'day' | 'hour',
  ): StatsSnapshot {
    let prompt = 0
    let completion = 0
    let total = 0
    let requests = 0
    let failed = 0
    let duration = 0
    for (const point of points) {
      prompt += point.prompt_tokens
      completion += point.completion_tokens
      total += point.total_tokens
      requests += point.requests
      failed += point.failed
      duration += point.duration_ms
    }
    const avgRate = duration > 0 ? completion / (duration / 1000) : 0
    const rollups = [...models.values()].sort((a, b) => b.total_tokens - a.total_tokens)
    return {
      range,
      unit,
      from,
      to,
      points,
      totals: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
        requests,
        failed,
        avg_rate: Number(avgRate.toFixed(1)),
      },
      models: rollups,
    }
  }

  /** Lifetime + retention metadata for the panel headline. */
  summary(): { lifetime: LifetimeTotals; keepDays: number; earliest: string | null } {
    return { lifetime: this.lifetime(), keepDays: this.keepDays, earliest: this.#earliestDay() }
  }
}

function mergeRollup(target: Map<string, ModelRollup>, source: ModelRollup): void {
  const existing = target.get(source.model) ?? emptyRollup(source.model)
  existing.prompt_tokens += source.prompt_tokens
  existing.completion_tokens += source.completion_tokens
  existing.total_tokens += source.total_tokens
  existing.requests += source.requests
  existing.failed += source.failed
  target.set(source.model, existing)
}

/** One completed request, as the overview table shows it. */
export interface RecentRequest {
  seq: number
  time: string
  model: string
  status: number
  streaming: boolean
  prompt_tokens: number
  completion_tokens: number
  duration_ms: number
  /** Time to first byte from upstream, ms — how long the user waited. */
  ttft_ms?: number
  /** Upstream identity the request rode, for correlation with server logs. */
  session?: string
  error?: string
}

/**
 * A small ring of the most recent requests. The overview page reads this; the
 * full history lives in the stats buckets.
 */
export class RecentRequests {
  readonly #capacity: number
  #entries: RecentRequest[] = []
  #seq = 0

  constructor(capacity = 50) {
    this.#capacity = Math.max(1, capacity)
  }

  push(entry: Omit<RecentRequest, 'seq' | 'time'> & { time?: string }): void {
    this.#entries.push({
      seq: this.#seq++,
      time: entry.time ?? new Date().toISOString(),
      ...entry,
    })
    if (this.#entries.length > this.#capacity) {
      this.#entries = this.#entries.slice(this.#entries.length - this.#capacity)
    }
  }

  /** Newest first, which is the order the panel renders. */
  list(limit = this.#capacity): RecentRequest[] {
    const reversed = [...this.#entries].reverse()
    return reversed.slice(0, limit)
  }

  clear(): void {
    this.#entries = []
  }
}
