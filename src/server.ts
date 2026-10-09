import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { extractToken, tokenMatches } from './httpauth.ts'

import { isVisionModel, ModelCatalog, type CatalogSnapshot } from './catalog.ts'
import type { ServiceConfig } from './config.ts'
import { toEffortIDs } from './gate.ts'
import {
  emptyAggregate,
  emptyResponsesAggregate,
  foldChatChunk,
  foldResponsesEvent,
  toChatCompletion,
  toResponsesObject,
  rewriteChatChunk,
} from './openai.ts'
import {
  PreContentFailure,
  proxySse,
  ZenUpstream,
} from './upstream.ts'
import {
  chatToResponsesObject,
  ChatToResponses,
  needsUpstreamResponses,
  responsesToChat,
} from './responses.ts'
import type { RecentRequests, StatsStore, UsageRecord } from './stats.ts'

/**
 * The HTTP surface: an OpenAI-compatible server in front of the Zen anonymous
 * lane.
 *
 *   GET  /v1/models              the exposed roster
 *   GET  /v1/models/<id>         one model
 *   POST /v1/chat/completions    Chat Completions (stream and non-stream)
 *   POST /v1/responses           Responses API (stream and non-stream)
 *   GET  /healthz                health and catalog diagnostics
 *   *    /panel/*                the management panel
 */

const VERSION = '1.0.0'

export interface LogFn {
  (level: 'error' | 'warn' | 'info' | 'debug', message: string, extra?: Record<string, unknown>): void
}

/** Optional usage accounting; absent in unit tests that do not exercise it. */
export interface UsageSink {
  stats?: StatsStore
  recent?: RecentRequests
}

export interface ServerDeps {
  config: ServiceConfig
  /** The config in force right now; falls back to `config` when absent. */
  getConfig?: () => ServiceConfig
  catalog: ModelCatalog
  upstream: ZenUpstream
  log: LogFn
  /** The panel handler, when the panel is enabled. */
  panel?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>
  usage?: UsageSink
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

interface ApiError {
  status: number
  message: string
  type: string
  code?: string
}

function errorPayload(error: ApiError): Record<string, unknown> {
  return {
    error: {
      message: error.message,
      type: error.type,
      ...(error.code ? { code: error.code } : {}),
      ...(error.status === 401 ? { code: 'invalid_api_key' } : {}),
    },
  }
}

function apiError(status: number, message: string, type = 'invalid_request_error', code?: string): ApiError {
  return { status, message, type, ...(code ? { code } : {}) }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw apiError(413, `request body exceeds ${limit} bytes`, 'invalid_request_error', 'payload_too_large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Authenticate an API request. The agent key is checked first: it is what
 * properly-configured integrations carry, and the panel key is accepted too so
 * a single-key setup (or a person poking with curl) still works.
 */
function authorize(req: IncomingMessage, config: ServiceConfig): ApiError | null {
  const expected = [config.agentKey, config.apiKey].filter((value) => value.length > 0)
  if (expected.length === 0) return null
  const token = extractToken(req.headers)
  if (token.length > 0 && expected.some((value) => tokenMatches(token, value))) return null
  return apiError(401, 'invalid API key', 'invalid_request_error', 'invalid_api_key')
}

function modelObject(catalog: ModelCatalog, id: string, config: ServiceConfig): Record<string, unknown> {
  const limits = catalog.limits(id)
  const capability = catalog.reasoningCapability(id)
  const modalities = isVisionModel(id, catalog.modalities(id)) ? ['text', 'image'] : ['text']
  const object: Record<string, unknown> = {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'opencode',
    context_window: limits?.contextWindow ?? 262144,
    max_output_tokens: limits?.maxOutput ?? 32768,
    input_modalities: modalities,
  }
  if (capability?.reasoning) {
    const declared = toEffortIDs(capability.effortValues)
    object.reasoning = { effort: declared.length > 0 ? declared : ['off', 'minimal', 'low', 'medium', 'high'] }
  }
  if (config.exposeAllModels) object.free = id.toLowerCase().includes('free')
  return object
}

export function createApp(deps: ServerDeps): Server {
  const { catalog, upstream, log } = deps
  // Re-read per handler invocation so a panel save applies without a restart.
  const cfg = (): ServiceConfig => deps.getConfig?.() ?? deps.config
  const stats = deps.usage?.stats
  const recent = deps.usage?.recent

  /**
   * Account for one finished request. Numbers come from the aggregated stream
   * (upstream reports real usage on its final chunk); a failed or empty stream
   * still counts as a request so the success rate stays honest.
   */
  const account = (
    model: string,
    started: number,
    result: { usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null; ttftMs?: number; failed: boolean; error?: string; streaming: boolean },
  ): void => {
    const durationMs = Date.now() - started
    const prompt = result.usage?.prompt_tokens ?? 0
    const completion = result.usage?.completion_tokens ?? 0
    const total = result.usage?.total_tokens ?? prompt + completion
    const record: UsageRecord = {
      model,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      durationMs,
      failed: result.failed,
    }
    stats?.record(record)
    recent?.push({
      model,
      status: result.failed ? 502 : 200,
      streaming: result.streaming,
      prompt_tokens: prompt,
      completion_tokens: completion,
      duration_ms: durationMs,
      ...(result.ttftMs !== undefined ? { ttft_ms: result.ttftMs } : {}),
      ...(result.error ? { error: result.error } : {}),
    })
  }

  const modelIds = (): string[] => {
    // `exposeAllModels` advertises the whole live roster; the free gate still
    // applies to every request otherwise.
    const list = cfg().exposeAllModels ? catalog.allModels() : catalog.list()
    const preferred = cfg().defaultModel
    if (preferred && !list.includes(preferred)) return [preferred, ...list]
    return list
  }

  const resolveModel = (requested: unknown): string => {
    const id = typeof requested === 'string' ? requested.trim() : ''
    if (id.length > 0) return id
    const preferred = cfg().defaultModel
    if (preferred) return preferred
    throw apiError(400, 'you must provide a "model" parameter', 'invalid_request_error', 'missing_model')
  }

  /**
   * Resolve the target model, refusing ids the free lane should not serve.
   * A model the live roster does not carry is treated as unknown rather than
   * silently forwarded, so typos surface as 404 instead of an opaque upstream
   * failure.
   */
  const gateModel = (id: string): ApiError | null => {
    if (cfg().exposeAllModels) return null
    const decision = catalog.decision(id)
    if (decision.allowed) return null
    return apiError(
      404,
      `the model "${id}" is not available on the free lane (${decision.source}). Call GET /v1/models for the current roster.`,
      'invalid_request_error',
      'model_not_found',
    )
  }

  const upstreamWithLog = upstream

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handleModels(res: ServerResponse, url: URL): Promise<void> {
    const prefix = '/v1/models'
    const rest = url.pathname.slice(prefix.length).replace(/^\//, '')
    if (rest.length > 0) {
      const id = decodeURIComponent(rest)
      if (!modelIds().includes(id) && gateModel(id)) {
        json(res, 404, errorPayload(apiError(404, `model "${id}" not found`, 'invalid_request_error', 'model_not_found')))
        return
      }
      json(res, 200, modelObject(catalog, id, cfg()))
      return
    }
    const data = modelIds().map((id) => modelObject(catalog, id, cfg()))
    json(res, 200, { object: 'list', data })
  }

  function handleHealth(res: ServerResponse): void {
    const snapshot: CatalogSnapshot = catalog.snapshot()
    const issues: string[] = []
    if (snapshot.status === 'pending') issues.push('model_catalog_pending')
    else if (snapshot.exposed === 0) issues.push('model_catalog_empty')
    else if (snapshot.status === 'stale') issues.push('model_catalog_stale')
    if (catalog.lastError) issues.push(`last_error: ${catalog.lastError}`)
    const ready = issues.length === 0
    json(res, ready ? 200 : 503, {
      status: ready ? 'ok' : snapshot.status === 'pending' ? 'starting' : 'degraded',
      ready,
      version: VERSION,
      uptime_seconds: Math.round(process.uptime()),
      anonymous: true,
      models: {
        status: snapshot.status,
        exposed: snapshot.exposed,
        live: catalog.liveCount,
        ...(snapshot.lastRefresh ? { last_refresh: snapshot.lastRefresh } : {}),
      },
      ...(issues.length > 0 ? { issues } : {}),
    })
  }

  interface ChatBody {
    model?: unknown
    messages?: unknown
    stream?: unknown
    [key: string]: unknown
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, cfg().maxBodyBytes)
    let body: ChatBody
    try {
      body = JSON.parse(raw) as ChatBody
    } catch {
      json(res, 400, errorPayload(apiError(400, 'request body is not valid JSON', 'invalid_request_error')))
      return
    }
    if (!body || typeof body !== 'object') {
      json(res, 400, errorPayload(apiError(400, 'request body must be a JSON object', 'invalid_request_error')))
      return
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      json(res, 400, errorPayload(apiError(400, 'you must provide a non-empty "messages" array', 'invalid_request_error')))
      return
    }

    let model: string
    try {
      model = resolveModel(body.model)
    } catch (err) {
      const apiErr = err as ApiError
      json(res, apiErr.status, errorPayload(apiErr))
      return
    }
    const gate = gateModel(model)
    if (gate) {
      json(res, gate.status, errorPayload(gate))
      return
    }

    const wantsStream = body.stream === true
    const sessionHeader = req.headers['x-opencode-session']
    const session = typeof sessionHeader === 'string' ? sessionHeader : Array.isArray(sessionHeader) ? sessionHeader[0] : undefined
    // A client disconnect must tear the upstream stream down rather than leave
    // it running to completion.
    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    res.on('close', onClose)
    const signal = AbortSignal.any([AbortSignal.timeout(cfg().requestTimeoutMs), controller.signal])
    const startedAt = Date.now()
    let ttftMs: number | undefined
    let accounted = false

    try {
      const handle = await upstreamWithLog.stream({
        // The resolved model is written back into the body: a request that
        // omitted `model` and relied on the default must still tell upstream
        // which model to run.
        body: { ...(body as Record<string, unknown>), model },
        model,
        ...(session ? { session } : {}),
        signal,
      })

      const watchdogs = upstream.watchdogs(model)
      const aggregate = emptyAggregate(model)
      const noteFirstByte = (): void => {
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt
      }
      const finishAccounting = (failed: boolean, error?: string): void => {
        if (accounted) return
        accounted = true
        account(model, startedAt, {
          usage: aggregate.usage,
          ...(ttftMs !== undefined ? { ttftMs } : {}),
          failed,
          ...(error ? { error } : {}),
          streaming: wantsStream,
        })
      }

      if (wantsStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        const includeReasoning = cfg().includeReasoning
        for await (const frame of proxySse(handle.response, {
          ...watchdogs,
          signal: controller.signal,
          onFirstEvent: noteFirstByte,
          onData: (data) => {
            if (data === '[DONE]') return
            noteFirstByte()
            try {
              foldChatChunk(aggregate, data)
            } catch {
              // aggregation is best-effort; the client stream is authoritative
            }
          },
          transform: (data) => {
            if (data === '[DONE]') return data
            return rewriteChatChunk(data, { reasoningAlias: includeReasoning })
          },
        })) {
          if (res.writableEnded) break
          res.write(frame)
        }
        finishAccounting(aggregate.finishReason === 'error' || aggregate.usage === null)
        if (!res.writableEnded) res.end()
        return
      }

      // Non-streaming: drain upstream and aggregate into one completion.
      let streamError: string | null = null
      for await (const _frame of proxySse(handle.response, {
        ...watchdogs,
        signal: controller.signal,
        onFirstEvent: noteFirstByte,
        onData: (data) => {
          if (data === '[DONE]') return
          noteFirstByte()
          try {
            foldChatChunk(aggregate, data)
          } catch (err) {
            // An in-stream error object: the completion never completes, so
            // report it rather than returning an empty 200.
            streamError = err instanceof Error ? err.message : String(err)
          }
        },
      })) {
        // no client stream to feed; aggregation is the whole point
      }
      if (streamError !== null) {
        finishAccounting(true, streamError)
        json(res, 502, errorPayload(apiError(502, streamError, 'upstream_error', 'upstream_error')))
        return
      }
      finishAccounting(false)
      const completion = toChatCompletion(aggregate)
      if (!cfg().includeReasoning) {
        for (const choice of completion.choices as Array<Record<string, unknown>>) {
          const message = choice.message as Record<string, unknown>
          delete message.reasoning
          delete message.reasoning_content
        }
      }
      json(res, 200, completion)
    } catch (err) {
      if (!accounted) {
        accounted = true
        const message = err instanceof Error ? err.message : String(err)
        account(model, startedAt, { usage: null, failed: true, error: message, streaming: wantsStream })
      }
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      if (err instanceof PreContentFailure) {
        json(res, err.status, errorPayload(apiError(err.status, err.message, 'upstream_error', 'upstream_error')))
        return
      }
      if (err instanceof Error && err.name === 'AbortError') {
        json(res, 499, errorPayload(apiError(499, 'request aborted by the client', 'upstream_error', 'aborted')))
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      log('error', 'chat request failed', { model, message })
      json(res, 500, errorPayload(apiError(500, message, 'upstream_error')))
    } finally {
      res.off('close', onClose)
    }
  }

  interface ResponsesBody {
    model?: unknown
    input?: unknown
    stream?: unknown
    [key: string]: unknown
  }

  /**
   * Serve the Responses API.
   *
   * Upstream `/v1/responses` accepts only the Responses-only models
   * (`muse-spark-*`); every other model rejects it with
   * `ModelProtocolUnsupported`. So a Responses request for any other model is
   * translated to Chat Completions upstream and rendered back in Responses
   * shape, which keeps this endpoint usable no matter which free model is
   * selected.
   */
  async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, cfg().maxBodyBytes)
    let body: ResponsesBody
    try {
      body = JSON.parse(raw) as ResponsesBody
    } catch {
      json(res, 400, errorPayload(apiError(400, 'request body is not valid JSON', 'invalid_request_error')))
      return
    }
    if (!body || typeof body !== 'object') {
      json(res, 400, errorPayload(apiError(400, 'request body must be a JSON object', 'invalid_request_error')))
      return
    }
    if (body.input === undefined) {
      json(res, 400, errorPayload(apiError(400, 'you must provide an "input" parameter', 'invalid_request_error')))
      return
    }
    let model: string
    try {
      model = resolveModel(body.model)
    } catch (err) {
      const apiErr = err as ApiError
      json(res, apiErr.status, errorPayload(apiErr))
      return
    }
    const gate = gateModel(model)
    if (gate) {
      json(res, gate.status, errorPayload(gate))
      return
    }

    const wantsStream = body.stream === true
    const native = needsUpstreamResponses(model)
    // A chat model reached through this endpoint needs translation; a
    // Responses-only model goes upstream as-is. Either way the resolved model is
    // authoritative, so a request relying on the configured default carries it.
    const translated = native ? (body as Record<string, unknown>) : responsesToChat(body as Record<string, unknown>)
    const upstreamBody = { ...translated, model }
    if (!native && (!Array.isArray(upstreamBody.messages) || upstreamBody.messages.length === 0)) {
      json(res, 400, errorPayload(apiError(400, 'the supplied input produced no messages', 'invalid_request_error')))
      return
    }

    const controller = new AbortController()
    const onClose = (): void => controller.abort()
    res.on('close', onClose)
    const signal = AbortSignal.any([AbortSignal.timeout(cfg().requestTimeoutMs), controller.signal])
    const startedAt = Date.now()
    let ttftMs: number | undefined
    let accounted = false
    const noteFirstByte = (): void => {
      if (ttftMs === undefined) ttftMs = Date.now() - startedAt
    }
    const finishAccounting = (
      failed: boolean,
      usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null,
      error?: string,
    ): void => {
      if (accounted) return
      accounted = true
      account(model, startedAt, {
        usage,
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        failed,
        ...(error ? { error } : {}),
        streaming: wantsStream,
      })
    }

    try {
      const handle = await upstreamWithLog.stream({ body: upstreamBody, model, signal })
      const watchdogs = upstream.watchdogs(model)
      const includeReasoning = cfg().includeReasoning

      if (wantsStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        if (native) {
          // Upstream already speaks Responses: pass the event stream through.
          const aggregate = emptyResponsesAggregate(model)
          for await (const frame of proxySse(handle.response, {
            ...watchdogs,
            signal: controller.signal,
            onFirstEvent: noteFirstByte,
            onData: (data) => {
              if (data === '[DONE]') return
              noteFirstByte()
              foldResponsesEvent(aggregate, '', data)
            },
          })) {
            if (res.writableEnded) break
            res.write(frame)
          }
          finishAccounting(
            aggregate.error !== null,
            aggregate.usage as { prompt_tokens?: number } | null,
            aggregate.error?.message,
          )
        } else {
          const aggregate = emptyAggregate(model)
          const renderer = new ChatToResponses(aggregate, { includeReasoning })
          for await (const _frame of proxySse(handle.response, {
            ...watchdogs,
            signal: controller.signal,
            onData: (data) => {
              if (data === '[DONE]') return
              noteFirstByte()
              // ChatToResponses folds the chunk itself so its own deltas and
              // the rendered events can never disagree.
              for (const event of renderer.push(data)) {
                if (!res.writableEnded) res.write(event)
              }
            },
            // The generator's own frames are not forwarded on this path (the
            // renderer owns the event vocabulary), so a watchdog timeout has to
            // be turned into a terminal event here or the client would wait
            // forever.
            onUpstreamError: (message) => {
              for (const event of renderer.fail(message)) {
                if (!res.writableEnded) res.write(event)
              }
            },
          })) {
            // events are written from onData as deltas arrive
          }
          for (const event of renderer.finish()) {
            if (!res.writableEnded) res.write(event)
          }
          finishAccounting(aggregate.finishReason === 'error' || aggregate.usage === null, aggregate.usage)
        }
        if (!res.writableEnded) res.end()
        return
      }

      // Non-streaming.
      if (native) {
        const aggregate = emptyResponsesAggregate(model)
        for await (const _frame of proxySse(handle.response, {
          ...watchdogs,
          signal: controller.signal,
          onFirstEvent: noteFirstByte,
          onData: (data) => {
            if (data === '[DONE]') return
            noteFirstByte()
            foldResponsesEvent(aggregate, '', data)
          },
        })) {
          // aggregate only
        }
        if (aggregate.error) {
          finishAccounting(true, aggregate.usage as { prompt_tokens?: number } | null, aggregate.error.message)
          json(res, 502, errorPayload(apiError(502, aggregate.error.message, 'upstream_error', aggregate.error.code)))
          return
        }
        finishAccounting(false, aggregate.usage as { prompt_tokens?: number } | null)
        json(res, 200, toResponsesObject(aggregate))
        return
      }

      const aggregate = emptyAggregate(model)
      for await (const _frame of proxySse(handle.response, {
        ...watchdogs,
        signal: controller.signal,
        onFirstEvent: noteFirstByte,
        onData: (data) => {
          if (data === '[DONE]') return
          noteFirstByte()
          try {
            foldChatChunk(aggregate, data)
          } catch {
            // best-effort; the terminal state below reports the failure
          }
        },
      })) {
        // aggregate only
      }
      finishAccounting(aggregate.finishReason === 'error' || aggregate.usage === null, aggregate.usage)
      json(res, 200, chatToResponsesObject(aggregate, { includeReasoning }))
    } catch (err) {
      if (!accounted) {
        accounted = true
        const message = err instanceof Error ? err.message : String(err)
        account(model, startedAt, { usage: null, failed: true, error: message, streaming: wantsStream })
      }
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      if (err instanceof PreContentFailure) {
        json(res, err.status, errorPayload(apiError(err.status, err.message, 'upstream_error', 'upstream_error')))
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      log('error', 'responses request failed', { model, message })
      json(res, 500, errorPayload(apiError(500, message, 'upstream_error')))
    } finally {
      res.off('close', onClose)
    }
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  return createServer((req, res) => {
    const started = Date.now()
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = (req.method ?? 'GET').toUpperCase()

    res.on('finish', () => {
      log('info', `${method} ${url.pathname}`, { status: res.statusCode, ms: Date.now() - started })
    })

    const route = async (): Promise<void> => {
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, x-opencode-session',
        })
        res.end()
        return
      }

      if (url.pathname === '/healthz' || url.pathname === '/health') {
        handleHealth(res)
        return
      }

      // The management panel owns its own auth and asset serving.
      if (deps.panel && (await deps.panel(req, res, url))) return

      if (url.pathname === '/') {
        json(res, 200, {
          name: 'opencodez-free',
          version: VERSION,
          description: "Local OpenAI-compatible server for OpenCode Zen's free anonymous model lane.",
          endpoints: ['/v1/models', '/v1/chat/completions', '/v1/responses', '/healthz'],
          panel: deps.panel ? '/panel/' : null,
        })
        return
      }

      const authError = authorize(req, cfg())
      if (authError) {
        json(res, authError.status, errorPayload(authError))
        return
      }

      if (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/')) {
        if (method !== 'GET') {
          json(res, 405, errorPayload(apiError(405, 'method not allowed', 'invalid_request_error')))
          return
        }
        await handleModels(res, url)
        return
      }

      if (url.pathname === '/v1/chat/completions') {
        if (method !== 'POST') {
          json(res, 405, errorPayload(apiError(405, 'method not allowed', 'invalid_request_error')))
          return
        }
        await handleChat(req, res)
        return
      }

      if (url.pathname === '/v1/responses') {
        if (method !== 'POST') {
          json(res, 405, errorPayload(apiError(405, 'method not allowed', 'invalid_request_error')))
          return
        }
        await handleResponses(req, res)
        return
      }

      json(res, 404, errorPayload(apiError(404, `unknown path ${url.pathname}`, 'invalid_request_error')))
    }

    route().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log('error', 'unhandled request error', { path: url.pathname, message })
      if (!res.headersSent) json(res, 500, errorPayload(apiError(500, message, 'internal_error')))
      else if (!res.writableEnded) res.end()
    })
  })
}
