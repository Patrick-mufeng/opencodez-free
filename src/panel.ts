import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { isVisionModel, type ModelCatalog } from './catalog.ts'
import {
  defaultAgentKeyPath,
  generateApiKey,
  readConfigFile,
  resolveConfig,
  writeKeyFile,
  type ServiceConfig,
} from './config.ts'
import { toEffortIDs } from './gate.ts'
import { extractToken, tokenMatches } from './httpauth.ts'
import type { LogRing, LogChannel } from './logring.ts'
import type { ModelProbe } from './probe.ts'
import type { RecentRequests, StatsStore, RangeKey } from './stats.ts'

/**
 * The management panel: a single-file frontend plus its JSON API.
 *
 *   GET  /panel/                     the page
 *   GET  /panel/app.js               the script
 *   GET  /panel/api/overview         service + catalog + recent requests
 *   GET  /panel/api/stats?range=     usage time series and rollups
 *   GET  /panel/api/models           the roster with capabilities
 *   GET  /panel/api/probe            probe results and queue
 *   POST /panel/api/probe            probe one model, or start a batch
 *   GET  /panel/api/logs?since=&channel=
 *   GET  /panel/api/config           the effective config
 *   POST /panel/api/config           write config back to the file
 */

export interface PanelDeps {
  config: ServiceConfig
  configPath: string
  catalog: ModelCatalog
  probe: ModelProbe
  stats: StatsStore
  recent: RecentRequests
  logs: LogRing
  /** The config in force right now; falls back to `config` when absent. */
  getConfig?: () => ServiceConfig
  /** Replace the live config after a panel save. */
  onConfigChange: (next: ServiceConfig) => void
  /**
   * Re-resolve the client key for a candidate config. A panel save rebuilds the
   * config from disk, and the generated key deliberately lives outside that
   * file — without this, saving would drop the key and silently disable auth.
   */
  resolveKey?: (config: ServiceConfig) => Promise<string>
  /** How the current key was obtained, for the panel's status line. */
  authSource?: 'configured' | 'stored' | 'generated' | 'disabled'
  /** Where a generated panel key is persisted. */
  authKeyPath?: string
  /** Where a generated agent key is persisted. */
  agentKeyPath?: string
  /** How the agent key was obtained, for the panel's status line. */
  agentKeySource?: 'configured' | 'stored' | 'generated' | 'disabled'
  log: (level: 'error' | 'warn' | 'info' | 'debug', message: string, extra?: Record<string, unknown>) => void
  startedAt: number
  version: string
}

/** Paths the panel serves from disk, resolved lazily so tests can inject them. */
export interface PanelAssets {
  html: () => Promise<string>
  js: () => Promise<string>
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function text(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return {}
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * The panel's own auth, which is OFF by default: the panel binds to loopback
 * and shows only this service, so requiring a password there is friction
 * without much gain. When `panelAuth` is on, only the panel key is accepted —
 * the agent key stays an API credential. A browser sends no header on a
 * navigation, so the key may also arrive as a query parameter or cookie.
 */
function authorize(req: IncomingMessage, url: URL, config: ServiceConfig): boolean {
  if (!config.panelAuth) return true
  const expected = config.panelKey && config.panelKey.length > 0 ? config.panelKey : config.apiKey
  if (expected.length === 0) return true
  const header = extractToken(req.headers)
  if (header.length > 0 && tokenMatches(header, expected)) return true
  const query = url.searchParams.get('key')?.trim() ?? ''
  if (query.length > 0 && tokenMatches(query, expected)) return true
  const cookie = req.headers.cookie ?? ''
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== 'opencodez_key') continue
    const value = decodeURIComponent(rest.join('='))
    if (value.length > 0 && tokenMatches(value, expected)) return true
  }
  return false
}

/**
 * Fields the panel is allowed to write back. Must cover every form control.
 *
 * `apiKey` / `agentKey` are included because an operator may want to pin their
 * own value; both are written only when the form actually carries one (a blank
 * field is dropped, meaning "keep using the generated key"). Normal use never
 * fills them, so a routine save cannot leak a generated key into the file.
 */
const EDITABLE_KEYS = [
  'host',
  'port',
  'auth',
  'panelAuth',
  'apiKey',
  'agentKey',
  'refreshSeconds',
  'exposeAllModels',
  'defaultModel',
  'includeReasoning',
  'firstEventMs',
  'bodyIdleMs',
  'responsesBodyIdleMs',
  'maxRotates',
  'maxBodyBytes',
  'requestTimeoutMs',
  'panel',
  'statsKeepDays',
  'logLevel',
] as const

export function createPanel(deps: PanelDeps, assets: PanelAssets) {
  // The live config is read per request: a panel save replaces it, and a value
  // captured at construction time would report the pre-save state forever.
  const currentConfig = (): ServiceConfig => deps.getConfig?.() ?? deps.config

  return async function handlePanel(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/panel')) return false
    const config = currentConfig()

    // The page itself must load before a key can be entered, so it is always
    // served; every API call behind it is gated.
    const isAsset = url.pathname === '/panel/' || url.pathname === '/panel' || url.pathname === '/panel/app.js'
    if (!isAsset && !authorize(req, url, config)) {
      json(res, 401, { error: 'invalid or missing key' })
      return true
    }

    if (url.pathname === '/panel' || url.pathname === '/panel/') {
      text(res, 200, await assets.html(), 'text/html; charset=utf-8')
      return true
    }
    if (url.pathname === '/panel/app.js') {
      text(res, 200, await assets.js(), 'text/javascript; charset=utf-8')
      return true
    }

    const method = (req.method ?? 'GET').toUpperCase()
    const route = url.pathname.slice('/panel/api/'.length)

    try {
      if (route === 'overview' && method === 'GET') {
        json(res, 200, overview(deps, config))
        return true
      }

      if (route === 'stats' && method === 'GET') {
        const range = (url.searchParams.get('range') ?? '30d') as RangeKey
        const valid: RangeKey[] = ['today', '7d', '30d', 'all']
        json(res, 200, {
          summary: deps.stats.summary(),
          ...deps.stats.snapshot(valid.includes(range) ? range : '30d'),
        })
        return true
      }

      if (route === 'models' && method === 'GET') {
        json(res, 200, { data: modelRows(deps, config), probe: probeState(deps) })
        return true
      }

      if (route === 'probe') {
        if (method === 'GET') {
          json(res, 200, probeState(deps))
          return true
        }
        if (method === 'POST') {
          const body = await readJson(req)
          if (typeof body.concurrency === 'number') deps.probe.setConcurrency(body.concurrency)
          if (typeof body.model === 'string' && body.model.length > 0) {
            const result = await deps.probe.probe(body.model)
            deps.log('info', `probe ${body.model}: ${result.status}`, { model: body.model })
            json(res, 200, { result, ...probeState(deps) })
            return true
          }
          const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === 'string') : undefined
          if (deps.probe.running) {
            json(res, 409, { error: 'a batch probe is already running', ...probeState(deps) })
            return true
          }
          const targets = models ?? deps.catalog.list()
          deps.probe.start(targets)
          deps.log('info', `probe started for ${targets.length} model(s)`, { channel: 'task', count: targets.length })
          json(res, 200, probeState(deps))
          return true
        }
      }

      if (route === 'tasks' && method === 'GET') {
        // The queue view the panel polls while a batch runs.
        json(res, 200, probeState(deps))
        return true
      }

      if (route === 'logs' && method === 'GET') {
        const channelParam = url.searchParams.get('channel')
        const channel: LogChannel | 'all' =
          channelParam === 'task' || channelParam === 'chat' || channelParam === 'sys' ? channelParam : 'all'
        const sinceRaw = url.searchParams.get('since')
        const since = sinceRaw !== null && sinceRaw !== '' ? Number(sinceRaw) : undefined
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw !== null && limitRaw !== '' ? Math.max(1, Math.min(2000, Number(limitRaw))) : 500
        json(res, 200, {
          entries: deps.logs.list({ channel, limit, ...(since !== undefined && Number.isFinite(since) ? { since } : {}) }),
          lastSeq: deps.logs.lastSeq,
          size: deps.logs.size,
        })
        return true
      }

      if (route === 'config' && method === 'GET') {
        json(res, 200, { path: deps.configPath, config: editable(currentConfig()) })
        return true
      }

      if (route === 'auth' && method === 'GET') {
        // Reading the keys requires presenting one when panel auth is on, so
        // this only ever echoes secrets the caller already holds. It exists so
        // a user who lost the console output can recover them.
        const live = currentConfig()
        const panelKey = live.panelKey ?? live.apiKey
        json(res, 200, {
          enabled: live.panelAuth,
          // `key` is the panel credential, kept for the existing panel UI.
          key: live.panelAuth ? panelKey : '',
          source: deps.authSource ?? (panelKey.length > 0 ? 'configured' : 'disabled'),
          path: deps.authKeyPath ?? null,
          // The agent credential, which is what an Agent integration needs.
          agent: {
            enabled: live.agentKey.length > 0,
            key: live.agentKey,
            source: deps.agentKeySource ?? (live.agentKey.length > 0 ? 'configured' : 'disabled'),
            path: deps.agentKeyPath ?? defaultAgentKeyPath(),
          },
        })
        return true
      }

      if (route === 'auth/rotate' && method === 'POST') {
        // Mint a new key and persist it, then swap it in. `target` selects which
        // credential rotates: rotating the agent key must not log the operator
        // out of the panel, and vice versa.
        const live = currentConfig()
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
        const target = body.target === 'agent' ? 'agent' : 'panel'
        const path = target === 'agent' ? (deps.agentKeyPath ?? defaultAgentKeyPath()) : deps.authKeyPath
        if (!path) {
          json(res, 400, { error: `no key path is configured for the ${target} key` })
          return true
        }
        if (target === 'agent' && !live.auth) {
          json(res, 400, { error: 'API authentication is disabled; enable it before rotating the agent key' })
          return true
        }

        const key = generateApiKey()
        await writeKeyFile(path, key)
        if (target === 'agent') {
          deps.onConfigChange({ ...live, agentKey: key })
          deps.log('info', 'agent key rotated', { path })
        } else {
          // Panel auth is off by default, so this is normally how a panel key
          // first comes into existence: minting one and switching the check on
          // are the same action, and the caller already holds the new key.
          const enabling = !live.panelAuth
          deps.onConfigChange({ ...live, panelKey: key, panelAuth: true })
          deps.log('info', enabling ? 'panel auth enabled with a new key' : 'panel key rotated', { path })
        }
        json(res, 200, { target, key, path, enabled: true })
        return true
      }

      if (route === 'config' && method === 'POST') {
        const body = await readJson(req)
        const next = await saveConfig(deps, body)
        json(res, 200, { path: deps.configPath, config: editable(next), saved: true })
        return true
      }

      if (route === 'stats/reset' && method === 'POST') {
        // Deliberately narrow: clears only the in-memory recent-request ring,
        // never the persisted usage history.
        deps.recent.clear()
        json(res, 200, { cleared: true })
        return true
      }

      json(res, 404, { error: `unknown panel path ${url.pathname}` })
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      deps.log('error', `panel ${route} failed`, { message })
      json(res, 500, { error: message })
      return true
    }
  }
}

/**
 * The subset of config the panel form owns. Every editable key is present, with
 * an absent optional field rendered as an empty string, so a form control never
 * binds to `undefined` (which would show as blank and read back as unchanged).
 *
 * `apiKey` and `agentKey` are deliberately blanked: the effective keys may be
 * auto-generated and live outside the config file, and echoing them here would
 * let a routine "save" write a secret into a file the user might share. A blank
 * field means "keep using the generated key", and the panel shows the real keys
 * through its own endpoint.
 */
function editable(config: ServiceConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of EDITABLE_KEYS) {
    const value = config[key]
    out[key] = value === undefined ? '' : value
  }
  out.apiKey = ''
  out.agentKey = ''
  out.hasApiKey = (config.panelKey ?? config.apiKey).length > 0
  return out
}

/**
 * Merge a panel submission into the config file and re-resolve. Only editable
 * keys are accepted, so the form can never rewrite an unknown field.
 */
async function saveConfig(deps: PanelDeps, body: Record<string, unknown>): Promise<ServiceConfig> {
  const updates: Record<string, unknown> = {}
  for (const key of EDITABLE_KEYS) {
    if (key in body) updates[key] = body[key]
  }
  const file = await readConfigFile(deps.configPath).catch(() => ({}))
  const merged: Record<string, unknown> = { ...file, ...updates }
  // Drop keys explicitly cleared so they fall back to their defaults. apiKey is
  // included here: a blank field means "keep using the generated key", so the
  // file should say nothing at all rather than pin an empty string.
  for (const [key, value] of Object.entries(merged)) {
    if (value === '') delete merged[key]
  }
  const resolved = resolveConfig(merged, process.env, {})
  // Both keys normally live outside the file, so reattach them; otherwise a save
  // would leave a check enabled with nothing to compare against. An explicit
  // value in the submission has already flowed into `resolved`.
  //
  // The panel key is resolved through the same helper the startup path uses,
  // which honours the submitted `panelAuth`: with the check off there is no
  // panel credential at all.
  const previous = deps.getConfig?.() ?? deps.config
  const panelKey = resolved.panelAuth
    ? (deps.resolveKey ? await deps.resolveKey(resolved) : resolved.apiKey)
    : ''
  const next: ServiceConfig = {
    ...resolved,
    apiKey: panelKey,
    panelKey,
    agentKey: resolved.auth
      ? (resolved.agentKey.length > 0 ? resolved.agentKey : previous.agentKey)
      : '',
  }
  await mkdir(dirname(deps.configPath), { recursive: true })
  await writeFile(deps.configPath, JSON.stringify(merged, null, 2), 'utf8')
  deps.onConfigChange(next)
  deps.log('info', 'panel saved configuration', { path: deps.configPath })
  return next
}

function overview(deps: PanelDeps, config: ServiceConfig): Record<string, unknown> {
  const snapshot = deps.catalog.snapshot()
  const lifetime = deps.stats.lifetime()
  const probe = deps.probe.progress()
  return {
    service: {
      version: deps.version,
      uptime_seconds: Math.round((Date.now() - deps.startedAt) / 1000),
      started_at: new Date(deps.startedAt).toISOString(),
      host: config.host,
      port: config.port,
      base_url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/v1`,
      auth: config.agentKey.length > 0,
      panel_auth: config.panelAuth,
      auth_source: deps.authSource ?? (config.apiKey.length > 0 ? 'configured' : 'disabled'),
      auth_key_path: deps.authKeyPath ?? null,
      config_path: deps.configPath,
    },
    catalog: {
      status: snapshot.status,
      exposed: snapshot.exposed,
      live: deps.catalog.liveCount,
      last_refresh: snapshot.lastRefresh ?? null,
      last_error: deps.catalog.lastError || null,
      expose_all: config.exposeAllModels,
    },
    usage: {
      total_tokens: lifetime.total_tokens,
      prompt_tokens: lifetime.prompt_tokens,
      completion_tokens: lifetime.completion_tokens,
      requests: lifetime.requests,
      failed: lifetime.failed,
      since: lifetime.since,
    },
    probe: { ...probe, results: probeCounts(deps) },
    recent: deps.recent.list(20),
  }
}

function probeCounts(deps: PanelDeps): { ok: number; fail: number; pending: number } {
  let ok = 0
  let fail = 0
  let pending = 0
  for (const result of deps.probe.results()) {
    if (result.status === 'ok') ok++
    else if (result.status === 'fail') fail++
    else pending++
  }
  return { ok, fail, pending }
}

function probeState(deps: PanelDeps): Record<string, unknown> {
  return {
    running: deps.probe.running,
    concurrency: deps.probe.concurrency,
    progress: deps.probe.progress(),
    results: deps.probe.results(),
    queue: deps.probe.queue(),
    counts: probeCounts(deps),
  }
}

/** Model rows for the panel's 模型与档位 table. */
function modelRows(deps: PanelDeps, config: ServiceConfig): Record<string, unknown>[] {
  const ids = config.exposeAllModels ? deps.catalog.allModels() : deps.catalog.list()
  const decisions = new Map<string, string>()
  for (const id of ids) decisions.set(id, deps.catalog.decision(id).source)
  return ids.map((id) => {
    const limits = deps.catalog.limits(id)
    const capability = deps.catalog.reasoningCapability(id)
    const declared = capability?.reasoning ? toEffortIDs(capability.effortValues) : []
    return {
      id,
      source: decisions.get(id) ?? 'unknown',
      free: id.toLowerCase().includes('free'),
      context_window: limits?.contextWindow ?? 262144,
      max_output: limits?.maxOutput ?? 32768,
      reasoning: capability?.reasoning === true,
      efforts: declared,
      default_effort: 'medium',
      input_modalities: isVisionModel(id, deps.catalog.modalities(id)) ? ['text', 'image'] : ['text'],
      protocol: /^muse-spark/i.test(id) ? 'responses' : 'completions',
    }
  })
}

/** Load the panel assets from disk (they are not embedded in the binary). */
export function createAssets(dir: string): PanelAssets {
  return {
    html: () => readFile(`${dir}/index.html`, 'utf8'),
    js: () => readFile(`${dir}/app.js`, 'utf8'),
  }
}
