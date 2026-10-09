import { deriveRequestIDs, disguiseHeaders, opencodeUserAgent, type RequestIDs } from './ids.ts'
import { ensureChatFreeLaneShape, ensureResponsesFreeLaneShape, reasoningEffortWire, isResponsesModel } from './gate.ts'
import { ZEN_BASE_URL } from './catalog.ts'

/**
 * The upstream client: one HTTP call to the Zen anonymous lane, with the CLI
 * disguise headers, the free-lane body gate, and stream-liveness watchdogs.
 *
 * The watchdogs exist because neither fetch nor the upstream client owns a
 * body-silence timeout: a tunnel that stands but never streams would hang the
 * turn forever. FIRST_EVENT covers time to the first stream event; BODY_IDLE
 * covers a long mid-response gap. Upstream sends `: keep-alive` comments while
 * it warms up, which must NOT count as liveness — those are filtered out below
 * before the watchdog sees them.
 */

export const DEFAULT_FIRST_EVENT_MS = 60_000
export const DEFAULT_BODY_IDLE_MS = 120_000
export const RESPONSES_BODY_IDLE_MS = 300_000

export const WATCHDOG_FIRST_MESSAGE = 'opencodez-free: first stream event timeout (upstream silent before any response)'
export const WATCHDOG_IDLE_MESSAGE = 'opencodez-free: stream body idle timeout (upstream went silent mid-response)'

/** How many times a pre-content failure is retried on a fresh identity. */
export const DEFAULT_MAX_ROTATES = 3

export interface UpstreamOptions {
  zenBaseUrl?: string
  firstEventMs?: number
  bodyIdleMs?: number
  responsesBodyIdleMs?: number
  maxRotates?: number
  fetchImpl?: typeof fetch
  /** Observability: called for each attempt outcome. */
  onAttempt?: (info: { attempt: number; outcome: string; detail: string }) => void
}

/** Where a selected effort came from, so the ladder check knows what to trust. */
export interface EffortContext {
  /** models.dev-declared values; empty means "declares nothing". */
  declared?: string[]
}

export interface StreamRequest {
  /** The caller's OpenAI-shaped body (chat/completions or responses). */
  body: Record<string, unknown>
  model: string
  /** Explicit session override from the inbound request header. */
  session?: string
  signal?: AbortSignal
}

export interface StreamHandle {
  response: Response
  /** The identity actually used, for diagnostics. */
  ids: RequestIDs
  attempts: number
}

/** A failure that happened before any content reached the caller. */
export class PreContentFailure extends Error {
  readonly status: number
  readonly attempts: number
  readonly detail: string

  constructor(message: string, options: { status: number; attempts: number; detail: string }) {
    super(message)
    this.name = 'PreContentFailure'
    this.status = options.status
    this.attempts = options.attempts
    this.detail = options.detail
  }
}

/** Upstream error classification, mirroring the original gateway's vocabulary. */
export function classifyFailure(message: string): string {
  if (/\bRegionError\b|not available in your country/i.test(message)) return 'region_blocked'
  if (/\bFreeTierError\b|free tier can only be used/i.test(message)) return 'free_tier'
  if (/\b(?:401|403)\b/.test(message)) return 'auth'
  if (/insufficient|quota|billing/i.test(message)) return 'quota'
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate_limit'
  if (/\b5\d\d\b/.test(message)) return 'server'
  if (/time(?:d)?\s*out|timeout/i.test(message)) return 'timeout'
  if (/network|connection|socket|fetch|ECONN|terminated|premature close/i.test(message)) return 'transport'
  return 'upstream'
}

/**
 * Whether a pre-content failure is worth retrying on a fresh identity. A
 * region block is deterministic for this machine (retrying with a new session
 * id cannot change the source address), so it is not retried; transient
 * transport/timeout/server failures are.
 */
export function shouldRotate(kind: string, deterministic: boolean): boolean {
  if (deterministic) return false
  return kind === 'transport' || kind === 'timeout' || kind === 'server' || kind === 'rate_limit' || kind === 'free_tier'
}

interface SseEvent {
  event: string
  data: string
}

/**
 * Incremental SSE parser. Yields data payloads; `: comment` lines are dropped
 * (they are upstream keep-alives, not evidence of a live model). Tolerant of
 * both LF and CRLF line endings, and of multi-line `data:` frames.
 */
export class SseParser {
  #buffer = ''
  #dataLines: string[] = []
  #eventName = ''

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk
    const out: SseEvent[] = []
    for (;;) {
      const boundary = this.#nextBoundary(this.#buffer)
      if (boundary === null) break
      const raw = this.#buffer.slice(0, boundary.index)
      this.#buffer = this.#buffer.slice(boundary.index + boundary.length)
      const flushed = this.#flushFrame(raw)
      if (flushed) out.push(flushed)
    }
    return out
  }

  /** Flush a trailing frame that arrived without its terminating blank line. */
  end(): SseEvent[] {
    const rest = this.#buffer
    this.#buffer = ''
    if (rest.trim().length === 0) return []
    const flushed = this.#flushFrame(rest)
    return flushed ? [flushed] : []
  }

  #nextBoundary(data: string): { index: number; length: number } | null {
    const lf = data.indexOf('\n\n')
    const crlf = data.indexOf('\r\n\r\n')
    if (lf < 0) return crlf < 0 ? null : { index: crlf, length: 4 }
    if (crlf >= 0 && crlf < lf) return { index: crlf, length: 4 }
    return { index: lf, length: 2 }
  }

  #flushFrame(raw: string): SseEvent | null {
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        this.#eventName = line.slice(6).trim()
        continue
      }
      if (line.startsWith('data:')) this.#dataLines.push(line.slice(5).trim())
    }
    if (this.#dataLines.length === 0) {
      this.#eventName = ''
      return null
    }
    const event: SseEvent = { event: this.#eventName, data: this.#dataLines.join('\n') }
    this.#eventName = ''
    this.#dataLines = []
    return event
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pull a readable message out of an upstream error body. The free lane wraps
 * its failures in an OpenAI-shaped envelope, sometimes nested twice
 * (`{"error":{"type":"error","error":{"type":"...","message":"..."}}}`), so
 * walk inward until a message appears.
 */
export function upstreamErrorMessage(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return trimmed.slice(0, 300)
  }
  const seen = new Set<unknown>()
  let node: unknown = parsed
  for (let depth = 0; depth < 4 && isRecord(node) && !seen.has(node); depth++) {
    seen.add(node)
    const candidate = node
    if (typeof candidate.message === 'string' && candidate.message.length > 0) return candidate.message.slice(0, 300)
    if (typeof candidate.error === 'string' && candidate.error.length > 0) return candidate.error.slice(0, 300)
    if (isRecord(candidate.error)) {
      node = candidate.error
      continue
    }
    break
  }
  return trimmed.slice(0, 300)
}

/**
 * Whether an upstream rejection is about the `reasoning_effort` value.
 *
 * Free models carry per-model effort ladders and reject anything outside them
 * with a hard 400 (live-probed 2026-10-09: big-pickle accepts
 * low/medium/high/xhigh but rejects `none`; fledge-alpha-free rejects it too).
 * models.dev does not always declare a ladder, so this cannot be predicted —
 * the request is retried without the field instead.
 */
export function isEffortRejection(message: string): boolean {
  return /reasoning_effort|reasoning effort/i.test(message) && /unsupported|not support|invalid|expected one of|allowed values/i.test(message)
}

export class ZenUpstream {
  readonly #options: Required<Pick<UpstreamOptions, 'zenBaseUrl' | 'firstEventMs' | 'bodyIdleMs' | 'responsesBodyIdleMs' | 'maxRotates'>>
  readonly #fetch: typeof fetch
  readonly #onAttempt?: UpstreamOptions['onAttempt']

  constructor(options: UpstreamOptions = {}) {
    this.#options = {
      zenBaseUrl: options.zenBaseUrl ?? ZEN_BASE_URL,
      firstEventMs: options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS,
      bodyIdleMs: options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS,
      responsesBodyIdleMs: options.responsesBodyIdleMs ?? RESPONSES_BODY_IDLE_MS,
      maxRotates: options.maxRotates ?? DEFAULT_MAX_ROTATES,
    }
    this.#fetch = options.fetchImpl ?? fetch
    this.#onAttempt = options.onAttempt
  }

  get baseUrl(): string {
    return this.#options.zenBaseUrl.replace(/\/+$/, '')
  }

  /** The `reasoning_effort` value a request should carry, if any. */
  #effortWire(selected: string | undefined): string | undefined {
    return reasoningEffortWire(selected)
  }

  /**
   * Shape one outgoing body: free-lane gate tools, and the reasoning effort in
   * the spelling the gateway validates.
   */
  shapeBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
    const isResponses = isResponsesModel(model)
    // reasoning_effort is a Chat Completions field; the Responses path nests it.
    const { reasoning_effort: _legacy, reasoningEffort: _camel, ...rest } = body
    let shaped = rest
    if (isResponses) {
      // The Responses models take a nested effort and reject `none`, so `off`
      // is dropped rather than translated.
      const raw = body.reasoning_effort ?? body.reasoningEffort ?? (isRecord(body.reasoning) ? body.reasoning.effort : undefined)
      const selected = typeof raw === 'string' ? raw : undefined
      const effort = selected === 'off' || selected === 'none' ? undefined : this.#effortWire(selected)
      const reasoning = isRecord(body.reasoning) ? { ...body.reasoning } : {}
      if (effort !== undefined) reasoning.effort = effort
      else delete reasoning.effort
      const withReasoning = { ...shaped }
      if (Object.keys(reasoning).length > 0) withReasoning.reasoning = reasoning
      else delete withReasoning.reasoning
      shaped = (ensureResponsesFreeLaneShape(withReasoning) as Record<string, unknown> | undefined) ?? withReasoning
    } else {
      const gated = (ensureChatFreeLaneShape(shaped) as Record<string, unknown> | undefined) ?? shaped
      const effort = this.#effortWire(typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined)
      shaped = effort === undefined ? gated : { ...gated, reasoning_effort: effort }
    }
    // The lane refuses non-streaming bodies outright.
    return { ...shaped, stream: true }
  }

  /** The endpoint path for a model. */
  pathFor(model: string): string {
    return isResponsesModel(model) ? '/v1/responses' : '/v1/chat/completions'
  }

  /**
   * Send one streaming request, retrying pre-content failures on a fresh
   * identity. Returns as soon as the response headers are known to be OK: the
   * caller then owns the body stream. Content that already started flowing is
   * never replayed, so a payload limit cannot inflate a call.
   */
  async stream(request: StreamRequest): Promise<StreamHandle> {
    const body = this.shapeBody(request.body, request.model)
    const path = this.pathFor(request.model)
    const url = `${this.baseUrl}${path}`
    const maxRotates = this.#options.maxRotates
    const story: string[] = []
    // Set once a model rejects our effort value, so every later attempt omits it
    // rather than re-sending a value this model will refuse again.
    let dropEffort = false

    for (let attempt = 0; attempt <= maxRotates; attempt++) {
      const payload: Record<string, unknown> = dropEffort ? this.withoutEffort(body, request.model) : body
      const ids = deriveRequestIDs(
        Array.isArray(payload.input) ? (payload.input as Array<{ role?: string; content?: unknown }>) : Array.isArray(payload.messages) ? (payload.messages as Array<{ role?: string; content?: unknown }>) : [],
        { session: request.session },
      )
      let response: Response
      try {
        response = await this.#fetch(url, {
          method: 'POST',
          headers: {
            ...disguiseHeaders(ids),
            authorization: 'Bearer public',
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(payload),
          signal: request.signal,
        })
      } catch (err) {
        if (request.signal?.aborted) throw err
        const message = err instanceof Error ? err.message : String(err)
        const kind = classifyFailure(message)
        story.push(`#${attempt + 1} ${kind}: ${message.slice(0, 80)}`)
        this.#onAttempt?.({ attempt: attempt + 1, outcome: `error:${kind}`, detail: message })
        if (attempt < maxRotates && shouldRotate(kind, false)) continue
        throw new PreContentFailure(message, { status: 502, attempts: attempt + 1, detail: story.join(' -> ') })
      }

      if (response.ok) {
        this.#onAttempt?.({ attempt: attempt + 1, outcome: 'ok', detail: `HTTP ${response.status}` })
        return { response, ids, attempts: attempt + 1 }
      }

      const text = await response.text().catch(() => '')
      const kind = this.#kindFromResponse(response, text)

      // A model whose ladder excludes our value: retry once without the field
      // rather than failing the turn over a cosmetic option.
      if (!dropEffort && isEffortRejection(text)) {
        dropEffort = true
        story.push(`#${attempt + 1} effort_rejected: ${upstreamErrorMessage(text).slice(0, 80)}`)
        this.#onAttempt?.({ attempt: attempt + 1, outcome: 'effort_rejected', detail: upstreamErrorMessage(text) })
        if (attempt < maxRotates) continue
      }

      story.push(`#${attempt + 1} ${kind}: ${text.slice(0, 120)}`)
      this.#onAttempt?.({ attempt: attempt + 1, outcome: `http:${response.status}`, detail: text.slice(0, 200) })

      // A region block is deterministic for this machine: retrying cannot help.
      const deterministic = kind === 'region_blocked'
      if (attempt < maxRotates && !deterministic && shouldRotate(kind, false)) continue
      throw new PreContentFailure(this.#humanMessage(kind, text), {
        status: response.status === 403 ? 403 : response.status >= 400 && response.status < 500 ? response.status : 502,
        attempts: attempt + 1,
        detail: story.join(' -> '),
      })
    }
    throw new PreContentFailure('opencodez-free: all upstream attempts failed', { status: 502, attempts: maxRotates + 1, detail: story.join(' -> ') })
  }

  /** The same body with every reasoning-effort spelling removed. */
  withoutEffort(body: Record<string, unknown>, model: string): Record<string, unknown> {
    const { reasoning_effort: _legacy, reasoning, ...rest } = body
    if (!isResponsesModel(model)) return rest
    // A Responses body nests the effort under `reasoning`; drop just that field.
    if (!isRecord(reasoning)) return rest
    const { effort: _effort, ...otherReasoning } = reasoning
    return Object.keys(otherReasoning).length > 0 ? { ...rest, reasoning: otherReasoning } : rest
  }

  #kindFromResponse(response: Response, text: string): string {
    const combined = `${response.status} ${text}`
    const kind = classifyFailure(combined)
    return kind === 'upstream' && response.status === 403 ? 'auth' : kind
  }

  #humanMessage(kind: string, text: string): string {
    if (kind === 'region_blocked') {
      return 'This model is not available in your country (upstream RegionError). It is served only from certain regions.'
    }
    if (kind === 'free_tier') {
      return 'The upstream free lane refused this request (FreeTierError). This usually means the request shape or identity was rejected.'
    }
    // Upstream errors arrive as a JSON envelope; surface its message rather than
    // raw JSON, which is unreadable in a table cell.
    const inner = upstreamErrorMessage(text)
    return inner.length > 0 ? inner : 'upstream request failed'
  }

  /**
   * Watchdog windows for one model: Responses models pace their reasoning in
   * bursts with long pauses, so they get the wider floor.
   */
  watchdogs(model: string): { firstEventMs: number; bodyIdleMs: number } {
    const isResponses = isResponsesModel(model)
    return {
      firstEventMs: this.#options.firstEventMs,
      bodyIdleMs: isResponses ? Math.max(this.#options.bodyIdleMs, this.#options.responsesBodyIdleMs) : this.#options.bodyIdleMs,
    }
  }

  userAgent(): string {
    return opencodeUserAgent()
  }
}

/**
 * Re-encode an upstream SSE byte stream, enforcing liveness watchdogs and
 * dropping keep-alive comments. `onData` receives each forwarded frame's raw
 * data payload so the caller can tap usage without rewriting the stream.
 *
 * Watchdog windows re-arm per chunk, but a single timer is reused rather than
 * allocated per token.
 */
export async function* proxySse(
  response: Response,
  options: {
    firstEventMs: number
    bodyIdleMs: number
    signal?: AbortSignal
    onData?: (data: string) => void
    /** Rewrite or drop one frame's payload; null drops the frame. */
    transform?: (data: string) => string | null
    /** Called once the first non-comment frame arrives. */
    onFirstEvent?: () => void
    /**
     * Called when the stream ends in a watchdog timeout. Consumers that render
     * their own event vocabulary need this: the synthesized error frame is not
     * routed through `onData`, so without it they would never learn the stream
     * died and could leave a client waiting for a terminal event.
     */
    onUpstreamError?: (message: string) => void
  },
): AsyncGenerator<string> {
  const body = response.body
  if (!body) throw new Error('upstream returned no body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let sawEvent = false
  let lastEventAt = Date.now()
  let timer: NodeJS.Timeout | undefined
  let timedOut: string | null = null

  // Abort handling is explicit rather than delegated to the fetch: a body that
  // does not itself react to the signal (a stub, or a proxy that swallowed it)
  // would otherwise leave reader.read() pending forever on a stalled stream.
  // One listener and one promise for the whole stream — a per-read gate would
  // accumulate listeners for the life of a long response.
  let aborted = options.signal?.aborted === true
  const abortPromise = new Promise<never>((_, reject) => {
    if (!options.signal) return
    options.signal.addEventListener(
      'abort',
      () => {
        aborted = true
        reject(new Error('request aborted'))
      },
      { once: true },
    )
  })
  // Nothing awaits the rejection when the stream simply ends first.
  abortPromise.catch(() => {})

  const arm = (): Promise<never> =>
    new Promise<never>((_, reject) => {
      clearTimeout(timer)
      const window = sawEvent ? options.bodyIdleMs : options.firstEventMs
      const label = sawEvent ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE
      const remaining = Math.max(0, window - (Date.now() - lastEventAt))
      timer = setTimeout(() => {
        timedOut = label
        reject(new Error(label))
      }, remaining)
      timer.unref?.()
    })

  try {
    for (;;) {
      if (aborted) return
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([reader.read(), arm(), abortPromise])
      } catch (err) {
        // A client disconnect is not an upstream failure: stop silently.
        if (aborted && timedOut === null) return
        const message = timedOut ?? (err instanceof Error ? err.message : String(err))
        options.onUpstreamError?.(message)
        yield sseFrame(JSON.stringify({ error: { message, type: 'upstream_timeout', code: 'timeout' } }))
        yield 'data: [DONE]\n\n'
        return
      }
      if (result.done) break
      const text = decoder.decode(result.value, { stream: true })
      if (text.length === 0) continue
      for (const event of parser.push(text)) {
        if (event.data.length === 0) continue
        if (!sawEvent) {
          sawEvent = true
          options.onFirstEvent?.()
        }
        lastEventAt = Date.now()
        options.onData?.(event.data)
        const payload = options.transform ? options.transform(event.data) : event.data
        if (payload === null || payload.length === 0) continue
        yield sseFrame(payload, event.event)
      }
    }
    for (const event of parser.end()) {
      if (event.data.length === 0) continue
      options.onData?.(event.data)
      const payload = options.transform ? options.transform(event.data) : event.data
      if (payload === null || payload.length === 0) continue
      yield sseFrame(payload, event.event)
    }
    clearTimeout(timer)
  } finally {
    clearTimeout(timer)
    try {
      await reader.cancel()
    } catch {
      // the stream is already gone
    }
  }
}

function sseFrame(data: string, event?: string): string {
  const name = event && event.length > 0 ? `event: ${event}\n` : ''
  return `${name}data: ${data}\n\n`
}
