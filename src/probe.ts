import { ModelCatalog } from './catalog.ts'
import { isResponsesModel } from './gate.ts'
import { proxySse, ZenUpstream } from './upstream.ts'

/**
 * Model diagnostics behind the panel's 诊断中心 page.
 *
 * The free roster rotates constantly and a listed model is not always a
 * working model (region blocks, protocol changes, silent upstream removal).
 * This runs a real one-shot completion per model and records whether it
 * answered, how fast, and why it failed — the same "probe and report" idea as
 * workbuddy-free's task center, applied to models instead of accounts.
 */

export type ProbeStatus = 'ok' | 'running' | 'pending' | 'fail'

export interface ProbeResult {
  model: string
  status: ProbeStatus
  /** Time to first token, ms. */
  ttft_ms?: number
  /** Total wall-clock for the probe, ms. */
  total_ms?: number
  /** Characters of text received, a rough liveness signal. */
  chars?: number
  /** Classified failure kind, when the probe failed. */
  error?: string
  /** Human-readable detail. */
  detail?: string
  /** Whether the model returned reasoning content. */
  reasoning?: boolean
  /** When the probe last ran. */
  at?: string
}

export interface ProbeQueueItem {
  model: string
  status: 'pending' | 'running' | 'done' | 'error'
  error?: string
  startedAt?: number
  finishedAt?: number
}

export interface ProbeOptions {
  /** Concurrency for the batch run. */
  concurrency?: number
  /** Per-probe watchdog in ms. */
  timeoutMs?: number
  /** The prompt sent to every model. */
  prompt?: string
  now?: () => number
}

const DEFAULT_PROMPT = 'Reply with the single word: ok'
/**
 * Probes are liveness checks, not conversations. The lane's slowest observed
 * time-to-first-token is ~23s, and a thinking model spends its budget before
 * emitting any text, so the window is generous and the token budget is large
 * enough that an always-think model still reaches an answer.
 */
const DEFAULT_TIMEOUT_MS = 120_000
const PROBE_MAX_TOKENS = 512

export class ModelProbe {
  readonly #upstream: ZenUpstream
  readonly #catalog: ModelCatalog
  #results = new Map<string, ProbeResult>()
  #queue: ProbeQueueItem[] = []
  #running = false
  #concurrency: number
  readonly #options: ProbeOptions
  #onEvent?: (event: { kind: 'started' | 'progress' | 'finished'; model?: string }) => void

  constructor(upstream: ZenUpstream, catalog: ModelCatalog, options: ProbeOptions = {}) {
    this.#upstream = upstream
    this.#catalog = catalog
    this.#options = options
    this.#concurrency = Math.max(1, options.concurrency ?? 2)
  }

  onEvent(handler: (event: { kind: 'started' | 'progress' | 'finished'; model?: string }) => void): void {
    this.#onEvent = handler
  }

  get running(): boolean {
    return this.#running
  }

  get concurrency(): number {
    return this.#concurrency
  }

  setConcurrency(value: number): void {
    this.#concurrency = Math.max(1, Math.min(8, Math.floor(value) || 1))
  }

  /** Every known result, keyed for the panel's table. */
  results(): ProbeResult[] {
    return [...this.#results.values()]
  }

  queue(): ProbeQueueItem[] {
    return [...this.#queue]
  }

  /**
   * Probe one model. A short non-streaming request is used: the service always
   * streams upstream, so this exercises the real path end to end.
   */
  async probe(model: string): Promise<ProbeResult> {
    const started = this.#options.now?.() ?? Date.now()
    const existing = this.#results.get(model)
    if (existing) {
      this.#results.set(model, { ...existing, status: 'running' })
    } else {
      this.#results.set(model, { model, status: 'running' })
    }
    const body = isResponsesModel(model)
      ? { model, input: [{ role: 'user', content: this.#options.prompt ?? DEFAULT_PROMPT }], max_output_tokens: PROBE_MAX_TOKENS }
      : {
          model,
          messages: [{ role: 'user', content: this.#options.prompt ?? DEFAULT_PROMPT }],
          max_tokens: PROBE_MAX_TOKENS,
        }
    // No `reasoning_effort` is sent: several free models reject values outside
    // their own narrow ladder (space-bunny-free answers a hard invalid_request
    // to `none`), and the probe should mirror what a default client sends
    // anyway. The generous budget above keeps a thinking model from starving
    // its own answer.

    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let ttft: number | undefined
    let chars = 0
    let sawReasoning = false
    let text = ''
    let streamError: string | null = null

    try {
      const handle = await this.#upstream.stream({ body, model, signal: controller.signal })
      const watchdogs = this.#upstream.watchdogs(model)
      for await (const frame of proxySse(handle.response, {
        ...watchdogs,
        signal: controller.signal,
        onData: (data) => {
          if (data === '[DONE]') return
          let parsed: {
            choices?: Array<{ delta?: { content?: string; reasoning?: string } }>
            type?: string
            delta?: string
            error?: { message?: string; type?: string }
          }
          try {
            parsed = JSON.parse(data)
          } catch {
            // A frame we cannot parse still proves the stream is alive.
            if (ttft === undefined) ttft = (this.#options.now?.() ?? Date.now()) - started
            return
          }
          // The relay surfaces a watchdog or teardown as an error frame; that is
          // a failure with a reason, not an empty response.
          if (parsed.error) {
            streamError = parsed.error.message ?? 'upstream stream error'
            return
          }
          if (ttft === undefined) ttft = (this.#options.now?.() ?? Date.now()) - started
          for (const choice of parsed.choices ?? []) {
            const content = choice.delta?.content
            if (typeof content === 'string' && content.length > 0) {
              chars += content.length
              text += content
            }
            if (typeof choice.delta?.reasoning === 'string' && choice.delta.reasoning.length > 0) sawReasoning = true
          }
          // Responses-protocol frames carry their text in `delta`.
          if (typeof parsed.delta === 'string' && parsed.type === 'response.output_text.delta') {
            chars += parsed.delta.length
            text += parsed.delta
          }
        },
      })) {
        // draining is the point
      }
      const total = (this.#options.now?.() ?? Date.now()) - started
      // The probe's own deadline aborting the stream is a timeout, not an empty
      // response: the relay stops silently on a caller abort, so the loop ends
      // normally and without this check the model would be blamed for it.
      if (controller.signal.aborted) {
        const result: ProbeResult = {
          model,
          status: 'fail',
          ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
          total_ms: total,
          chars,
          error: 'timeout',
          detail: text.length > 0
            ? `partial reply received (${text.slice(0, 80)}…), then no more output within ${Math.round(timeoutMs / 1000)}s`
            : `no reply within ${Math.round(timeoutMs / 1000)}s`,
          at: new Date().toISOString(),
        }
        this.#results.set(model, result)
        return result
      }
      if (streamError !== null) {
        const result: ProbeResult = {
          model,
          status: 'fail',
          ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
          total_ms: total,
          chars,
          error: /timeout|idle|silent/i.test(streamError) ? 'timeout' : 'error',
          detail: streamError,
          at: new Date().toISOString(),
        }
        this.#results.set(model, result)
        return result
      }
      const ok = chars > 0
      const result: ProbeResult = {
        model,
        status: ok ? 'ok' : 'fail',
        ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
        total_ms: total,
        chars,
        ...(sawReasoning ? { reasoning: true } : {}),
        at: new Date().toISOString(),
        ...(ok
          ? {}
          : {
              error: 'empty',
              detail: 'the model closed the stream without producing any text (it may have spent the whole budget thinking)',
            }),
      }
      this.#results.set(model, result)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const aborted = controller.signal.aborted
      const detail = text.length > 0 ? `partial reply received (${text.slice(0, 80)}…)` : aborted ? `no reply within ${Math.round(timeoutMs / 1000)}s` : message
      const result: ProbeResult = {
        model,
        status: 'fail',
        ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
        total_ms: (this.#options.now?.() ?? Date.now()) - started,
        chars,
        error: aborted || /timeout|abort/i.test(message) ? 'timeout' : 'error',
        detail,
        at: new Date().toISOString(),
      }
      this.#results.set(model, result)
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  /** Queue a batch run over the given ids (defaults to the exposed roster). */
  start(models?: string[]): ProbeQueueItem[] {
    const targets = models && models.length > 0 ? models : this.#catalog.list()
    this.#queue = targets.map((model) => ({ model, status: 'pending' as const }))
    for (const item of this.#queue) {
      // A queued model with no result yet shows as pending in the table.
      if (!this.#results.has(item.model)) this.#results.set(item.model, { model: item.model, status: 'pending' })
    }
    this.#running = true
    this.#onEvent?.({ kind: 'started' })
    void this.#drain()
    return this.queue()
  }

  async #drain(): Promise<void> {
    const pending = (): ProbeQueueItem | undefined => this.#queue.find((item) => item.status === 'pending')
    const workers = Array.from({ length: this.#concurrency }, async () => {
      for (;;) {
        const item = pending()
        if (!item) return
        item.status = 'running'
        item.startedAt = this.#options.now?.() ?? Date.now()
        this.#onEvent?.({ kind: 'progress', model: item.model })
        try {
          const result = await this.probe(item.model)
          item.status = result.status === 'ok' ? 'done' : 'error'
          if (result.status !== 'ok') item.error = result.detail ?? result.error
        } catch (err) {
          item.status = 'error'
          item.error = err instanceof Error ? err.message : String(err)
        }
        item.finishedAt = this.#options.now?.() ?? Date.now()
        this.#onEvent?.({ kind: 'progress', model: item.model })
      }
    })
    await Promise.all(workers)
    this.#running = false
    this.#onEvent?.({ kind: 'finished' })
  }

  /** Aggregate progress for the panel's progress bar. */
  progress(): { total: number; done: number; failed: number; running: boolean } {
    let done = 0
    let failed = 0
    for (const item of this.#queue) {
      if (item.status === 'done') done++
      else if (item.status === 'error') {
        done++
        failed++
      }
    }
    return { total: this.#queue.length, done, failed, running: this.#running }
  }
}
