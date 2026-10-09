import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { ZEN_BASE_URL, MODELS_DEV_URL } from './catalog.ts'
import { DEFAULT_FIRST_EVENT_MS, DEFAULT_BODY_IDLE_MS, RESPONSES_BODY_IDLE_MS, DEFAULT_MAX_ROTATES } from './upstream.ts'

/**
 * Configuration: defaults, an optional JSON config file, environment
 * variables, then command-line flags — each layer overriding the last.
 */

export interface ServiceConfig {
  /** Bind host. Defaults to loopback only. */
  host: string
  /** Bind port; 0 picks a free port. */
  port: number
  /**
   * Require a key from Agents calling /v1. On by default: the port is reachable
   * by every program on this machine, so leaving it open lets anything spend the
   * upstream free lane.
   */
  auth: boolean
  /**
   * Require a key to open the panel. Off by default: the panel is a local,
   * single-user view of your own service, and it binds to loopback, so a
   * password there is friction without much gain. Turn it on when the panel is
   * reachable by others (a shared machine, `--host 0.0.0.0`).
   */
  panelAuth: boolean
  /**
   * The panel's bearer token. Normally left empty: {@link resolveAuth} then
   * reuses the persisted generated key, or mints one on first run. An explicit
   * value here (config file, env, or flag) always wins.
   */
  apiKey: string
  /**
   * The key Agents use against /v1. Separate from {@link apiKey} on purpose:
   * agent integrations are copied into config files and CI secrets far more
   * often than the panel is, so rotating one must not log anyone out of the
   * other. Empty means "generate/reuse", same as {@link apiKey}.
   */
  agentKey: string
  /**
   * Runtime-only: the resolved panel key after {@link resolveKeys}. Not a
   * config-file field (the file carries {@link apiKey}); it exists so handlers
   * can tell the two credentials apart without another lookup.
   */
  panelKey?: string
  /** Upstream Zen base URL. */
  zenBaseUrl: string
  /** models.dev metadata URL. */
  metadataUrl: string
  /** Live roster refresh cadence in seconds. */
  refreshSeconds: number
  /** Where the models.dev cache is written. */
  cachePath?: string
  /** Expose the whole live roster instead of only free-by-metadata models. */
  exposeAllModels: boolean
  /** Default model when a request omits one. */
  defaultModel?: string
  /** Watchdog: ms to the first stream event. */
  firstEventMs: number
  /** Watchdog: ms of tolerated mid-stream silence (chat models). */
  bodyIdleMs: number
  /** Watchdog: body-idle floor for Responses models. */
  responsesBodyIdleMs: number
  /** Pre-content retry budget, on a fresh correlation identity each time. */
  maxRotates: number
  /** Include upstream reasoning in responses. */
  includeReasoning: boolean
  /** Request body size cap in bytes. */
  maxBodyBytes: number
  /** Per-request upstream timeout in ms. */
  requestTimeoutMs: number
  /** Serve the management panel at /panel/. */
  panel: boolean
  /** Days of per-day usage detail kept on disk (lifetime totals always survive). */
  statsKeepDays: number
  /** Where usage history is persisted. */
  statsPath?: string
  /** Log level. */
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug'
}

export const defaults: ServiceConfig = {
  host: '127.0.0.1',
  port: 8787,
  auth: true,
  panelAuth: false,
  apiKey: '',
  agentKey: '',
  zenBaseUrl: ZEN_BASE_URL,
  metadataUrl: MODELS_DEV_URL,
  refreshSeconds: 300,
  exposeAllModels: false,
  firstEventMs: DEFAULT_FIRST_EVENT_MS,
  bodyIdleMs: DEFAULT_BODY_IDLE_MS,
  responsesBodyIdleMs: RESPONSES_BODY_IDLE_MS,
  maxRotates: DEFAULT_MAX_ROTATES,
  includeReasoning: true,
  maxBodyBytes: 32 * 1024 * 1024,
  requestTimeoutMs: 600_000,
  panel: true,
  statsKeepDays: 30,
  logLevel: 'info',
}

export function defaultConfigPath(): string {
  const fromEnv = process.env.OPENCODEZ_CONFIG?.trim()
  if (fromEnv) return resolve(fromEnv)
  return join(homedir(), '.opencodez-free', 'config.json')
}

export function defaultCachePath(): string {
  return join(homedir(), '.opencodez-free', 'models.dev.json')
}

/** Where per-day usage history is written. */
export function defaultStatsPath(): string {
  return join(homedir(), '.opencodez-free', 'stats.json')
}

/**
 * Where the generated panel key lives. Deliberately a sibling of config.json
 * rather than a field inside it: the config file is the one a user is likely to
 * copy between machines or paste into an issue, and the key should not travel
 * with it.
 */
export function defaultApiKeyPath(): string {
  return join(homedir(), '.opencodez-free', 'api-key.txt')
}

/** Where the generated agent key lives; kept apart from the panel key. */
export function defaultAgentKeyPath(): string {
  return join(homedir(), '.opencodez-free', 'agent-key.txt')
}

/** Prefix so a generated key is recognisable in a client's API-key field. */
export const API_KEY_PREFIX = 'ozk_'

/** 24 random bytes, base64url — 32 characters, comfortably unguessable. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(24).toString('base64url')
}

export interface ResolvedAuth {
  /** The key in force. Empty means authentication is off. */
  key: string
  /** How the key was obtained; drives the startup log line. */
  source: 'configured' | 'stored' | 'generated' | 'disabled'
  /** The file consulted for a generated key. */
  path: string
}

export interface ResolvedKeys {
  /** Panel credential. */
  panel: ResolvedAuth
  /** Agent (/v1) credential. */
  agent: ResolvedAuth
}

/**
 * Resolve one key.
 *
 *   auth off            -> no key, no auth
 *   explicit value      -> used verbatim, never overwritten
 *   a key on disk       -> reused, so clients survive restarts
 *   otherwise           -> a fresh key is generated and persisted
 *
 * The explicit case is what lets an operator pin a key via env or flag without
 * the tool silently rotating it.
 */
export async function resolveOneKey(
  explicit: string,
  keyPath: string,
  enabled: boolean,
): Promise<ResolvedAuth> {
  if (!enabled) return { key: '', source: 'disabled', path: keyPath }
  const pinned = explicit.trim()
  if (pinned.length > 0) return { key: pinned, source: 'configured', path: keyPath }
  try {
    const stored = (await readFile(keyPath, 'utf8')).trim()
    if (stored.length > 0) return { key: stored, source: 'stored', path: keyPath }
  } catch {
    // No readable file yet: fall through and mint one.
  }
  const key = generateApiKey()
  await mkdir(dirname(keyPath), { recursive: true })
  await writeFile(keyPath, key + '\n', { encoding: 'utf8', mode: 0o600 })
  return { key, source: 'generated', path: keyPath }
}

/** Resolve the panel credential. */
export async function resolveAuth(
  config: ServiceConfig,
  keyPath = defaultApiKeyPath(),
  enabled = config.panelAuth,
): Promise<ResolvedAuth> {
  return resolveOneKey(config.apiKey, keyPath, enabled)
}

/**
 * Resolve both credentials.
 *
 * The two are independent, including their on/off switches:
 *
 *   panelAuth (default false) - the panel is a local, single-user view, so it
 *     opens without a password unless the operator asks for one.
 *   auth (default true)       - the API port is reachable by every program on
 *     the machine, so Agents must present the agent key.
 *
 * An explicit `agentKey` always wins over the stored file. One migration case
 * is handled explicitly: a setup from the single-key era has an `api-key.txt`
 * and no agent key, and its Agents were configured with that panel key. Minting
 * a different agent key there would silently disconnect every Agent, so the
 * existing key is adopted instead.
 */
export async function resolveKeys(
  config: ServiceConfig,
  paths: { panel?: string; agent?: string } = {},
): Promise<ResolvedKeys> {
  const panelPath = paths.panel ?? defaultApiKeyPath()
  const agentPath = paths.agent ?? defaultAgentKeyPath()

  // The legacy key file is read before deciding anything: a pre-split install
  // stored its only key there, and its Agents are configured with that value.
  const legacyKey = await readFile(panelPath, 'utf8').then(
    (value) => value.trim(),
    () => '',
  )

  const panel = config.panelAuth
    ? await resolveOneKey(config.apiKey, panelPath, true)
    : { key: '', source: 'disabled' as const, path: panelPath }

  if (!config.auth) return { panel, agent: { key: '', source: 'disabled', path: agentPath } }

  if (config.agentKey.trim().length === 0) {
    const storedAgent = await readFile(agentPath, 'utf8').then(
      (value) => value.trim(),
      () => '',
    )
    // Adopt the legacy key when this install predates the split and has not
    // been given an agent key yet. Minting a different one here would silently
    // disconnect every Agent that is already configured; on a genuinely fresh
    // install there is no legacy key, so the two keys stay distinct.
    if (storedAgent.length === 0 && legacyKey.length > 0) {
      await writeKeyFile(agentPath, legacyKey).catch(() => {})
      return { panel, agent: { key: legacyKey, source: 'stored', path: agentPath } }
    }
  }
  const agent = await resolveOneKey(config.agentKey, agentPath, true)
  return { panel, agent }
}

/**
 * Persist a freshly minted key, replacing whatever was there. Used by the
 * panel's rotate action, which must write the key the server is about to accept.
 */
export async function writeKeyFile(path: string, key: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, key + '\n', { encoding: 'utf8', mode: 0o600 })
}

function pickNumber(value: unknown, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  const int = Math.floor(parsed)
  if (int < min) return min
  if (int > max) return max
  return int
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true
    if (['0', 'false', 'no', 'off'].includes(lower)) return false
  }
  return fallback
}

function pickString(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return fallback
}

/** Read a JSON config file; a missing file is not an error. */
export async function readConfigFile(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Tolerate `//` and `/* *\/` comments so the config file can be annotated. */
function stripJsonComments(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (char === '/' && input[i + 1] === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++
      i++
      out += ' '
      continue
    }
    out += char
  }
  return out
}

export interface ParseArgsResult {
  config: ServiceConfig
  configPath: string
  /** Set when the caller asked for --help / --version. */
  action?: 'help' | 'version'
}

export interface CliOverrides {
  [key: string]: unknown
}

/** Merge file, environment, and flags over the defaults. */
export function resolveConfig(
  file: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
  overrides: CliOverrides = {},
): ServiceConfig {
  const source: Record<string, unknown> = { ...file }
  const fromEnv: Record<string, unknown> = {}
  const envMap: Array<[keyof ServiceConfig, string]> = [
    ['host', 'OPENCODEZ_HOST'],
    ['port', 'OPENCODEZ_PORT'],
    ['apiKey', 'OPENCODEZ_API_KEY'],
    ['agentKey', 'OPENCODEZ_AGENT_KEY'],
    ['auth', 'OPENCODEZ_AUTH'],
    ['panelAuth', 'OPENCODEZ_PANEL_AUTH'],
    ['zenBaseUrl', 'OPENCODEZ_ZEN_BASE_URL'],
    ['metadataUrl', 'OPENCODEZ_METADATA_URL'],
    ['refreshSeconds', 'OPENCODEZ_REFRESH_SECONDS'],
    ['cachePath', 'OPENCODEZ_CACHE_PATH'],
    ['exposeAllModels', 'OPENCODEZ_EXPOSE_ALL_MODELS'],
    ['defaultModel', 'OPENCODEZ_DEFAULT_MODEL'],
    ['firstEventMs', 'OPENCODEZ_FIRST_EVENT_MS'],
    ['bodyIdleMs', 'OPENCODEZ_BODY_IDLE_MS'],
    ['responsesBodyIdleMs', 'OPENCODEZ_RESPONSES_BODY_IDLE_MS'],
    ['maxRotates', 'OPENCODEZ_MAX_ROTATES'],
    ['includeReasoning', 'OPENCODEZ_INCLUDE_REASONING'],
    ['maxBodyBytes', 'OPENCODEZ_MAX_BODY_BYTES'],
    ['requestTimeoutMs', 'OPENCODEZ_REQUEST_TIMEOUT_MS'],
    ['panel', 'OPENCODEZ_PANEL'],
    ['statsKeepDays', 'OPENCODEZ_STATS_KEEP_DAYS'],
    ['statsPath', 'OPENCODEZ_STATS_PATH'],
    ['logLevel', 'OPENCODEZ_LOG_LEVEL'],
  ]
  for (const [key, name] of envMap) {
    const value = env[name]
    if (value !== undefined && value !== '') fromEnv[key] = value
  }
  // Precedence, weakest first: file, environment, command line.
  const merged: Record<string, unknown> = { ...source, ...fromEnv, ...overrides }

  const config: ServiceConfig = {
    host: pickString(merged.host, defaults.host),
    port: pickNumber(merged.port, defaults.port, { min: 0, max: 65535 }),
    apiKey: pickString(merged.apiKey, defaults.apiKey).trim(),
    agentKey: pickString(merged.agentKey, defaults.agentKey).trim(),
    auth: pickBoolean(merged.auth, defaults.auth),
    panelAuth: pickBoolean(merged.panelAuth, defaults.panelAuth),
    zenBaseUrl: pickString(merged.zenBaseUrl, defaults.zenBaseUrl).replace(/\/+$/, ''),
    metadataUrl: pickString(merged.metadataUrl, defaults.metadataUrl),
    refreshSeconds: Math.max(30, pickNumber(merged.refreshSeconds, defaults.refreshSeconds, { min: 30 })),
    exposeAllModels: pickBoolean(merged.exposeAllModels, defaults.exposeAllModels),
    firstEventMs: pickNumber(merged.firstEventMs, defaults.firstEventMs, { min: 1000, max: 600_000 }),
    bodyIdleMs: pickNumber(merged.bodyIdleMs, defaults.bodyIdleMs, { min: 1000, max: 600_000 }),
    responsesBodyIdleMs: pickNumber(merged.responsesBodyIdleMs, defaults.responsesBodyIdleMs, { min: 1000, max: 600_000 }),
    maxRotates: pickNumber(merged.maxRotates, defaults.maxRotates, { min: 0, max: 10 }),
    includeReasoning: pickBoolean(merged.includeReasoning, defaults.includeReasoning),
    maxBodyBytes: pickNumber(merged.maxBodyBytes, defaults.maxBodyBytes, { min: 1024 }),
    requestTimeoutMs: pickNumber(merged.requestTimeoutMs, defaults.requestTimeoutMs, { min: 1000, max: 3_600_000 }),
    panel: pickBoolean(merged.panel, defaults.panel),
    statsKeepDays: pickNumber(merged.statsKeepDays, defaults.statsKeepDays, { min: 1, max: 3650 }),
    logLevel: (['silent', 'error', 'warn', 'info', 'debug'] as const).includes(merged.logLevel as never)
      ? (merged.logLevel as ServiceConfig['logLevel'])
      : defaults.logLevel,
  }
  const cachePath = pickString(merged.cachePath, '').trim()
  config.cachePath = cachePath.length > 0 ? resolve(cachePath) : defaultCachePath()
  const statsPath = pickString(merged.statsPath, '').trim()
  config.statsPath = statsPath.length > 0 ? resolve(statsPath) : defaultStatsPath()
  const defaultModel = pickString(merged.defaultModel, '').trim()
  if (defaultModel.length > 0) config.defaultModel = defaultModel
  return config
}

/** Parse argv, returning the resolved config plus the file path consulted. */
export async function parseArgs(argv: string[]): Promise<ParseArgsResult> {
  const overrides: CliOverrides = {}
  let configPath = defaultConfigPath()
  let action: 'help' | 'version' | undefined

  const takesValue = new Set([
    'host',
    'port',
    'api-key',
    'agent-key',
    'zen-base-url',
    'metadata-url',
    'refresh-seconds',
    'cache-path',
    'config',
    'default-model',
    'first-event-ms',
    'body-idle-ms',
    'responses-body-idle-ms',
    'max-rotates',
    'max-body-bytes',
    'request-timeout-ms',
    'log-level',
    'stats-keep-days',
    'stats-path',
  ])
  const toCamel = (flag: string): string => flag.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') {
      action = 'help'
      continue
    }
    if (arg === '--version' || arg === '-v') {
      action = 'version'
      continue
    }
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    const flag = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).trim()
    if (flag === 'expose-all-models') {
      overrides.exposeAllModels = true
      continue
    }
    if (flag === 'no-reasoning') {
      overrides.includeReasoning = false
      continue
    }
    if (flag === 'no-panel') {
      overrides.panel = false
      continue
    }
    if (flag === 'no-auth') {
      overrides.auth = false
      continue
    }
    if (flag === 'auth') {
      overrides.auth = true
      continue
    }
    if (flag === 'panel-auth') {
      overrides.panelAuth = true
      continue
    }
    if (flag === 'no-panel-auth') {
      overrides.panelAuth = false
      continue
    }
    if (!takesValue.has(flag)) continue
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined
    const value = inline !== undefined ? inline : (argv[++i] ?? '')
    if (flag === 'config') {
      configPath = resolve(value)
      continue
    }
    overrides[toCamel(flag)] = value
  }

  let file: Record<string, unknown> = {}
  if (action === undefined) file = await readConfigFile(configPath)
  return { config: resolveConfig(file, process.env, overrides), configPath, ...(action ? { action } : {}) }
}

export const HELP_TEXT = `opencodez-free — a local OpenAI-compatible server for OpenCode Zen's free models

Usage:
  node src/index.ts [options]

Options:
  --host <host>                  Bind address (default 127.0.0.1)
  --port <port>                  Bind port (default 8787; 0 picks a free one)
  --api-key <key>                Use this panel key verbatim (skips generation)
  --agent-key <key>              Use this Agent (/v1) key verbatim
  --no-auth                      Disable API authentication entirely
  --panel-auth                   Require a key to open the panel (off by default)
  --no-panel-auth                Do not require a key for the panel (default)
  --config <path>                Config file (default ~/.opencodez-free/config.json)
  --zen-base-url <url>           Upstream Zen base (default ${ZEN_BASE_URL})
  --metadata-url <url>           models.dev metadata (default ${MODELS_DEV_URL})
  --refresh-seconds <n>          Roster refresh cadence (default 300, min 30)
  --cache-path <path>            models.dev cache path
  --default-model <id>           Model used when a request omits one
  --expose-all-models            Expose the whole live roster, not just free models
  --no-reasoning                 Omit upstream reasoning from responses
  --first-event-ms <n>           Watchdog: time to first stream event (default ${DEFAULT_FIRST_EVENT_MS})
  --body-idle-ms <n>             Watchdog: mid-stream silence tolerated (default ${DEFAULT_BODY_IDLE_MS})
  --responses-body-idle-ms <n>   Watchdog floor for Responses models (default ${RESPONSES_BODY_IDLE_MS})
  --max-rotates <n>              Pre-content retries on a fresh identity (default ${DEFAULT_MAX_ROTATES})
  --max-body-bytes <n>           Request body cap (default 33554432)
  --stats-keep-days <n>          Days of usage detail kept (default 30)
  --stats-path <path>            Usage history file
  --no-panel                     Disable the management panel
  --log-level <level>            silent | error | warn | info | debug (default info)
  --help, -h                     Show this help
  --version, -v                  Show the version

Environment:
  OPENCODEZ_HOST, OPENCODEZ_PORT, OPENCODEZ_API_KEY, OPENCODEZ_AUTH,
  OPENCODEZ_ZEN_BASE_URL,
  OPENCODEZ_METADATA_URL, OPENCODEZ_REFRESH_SECONDS, OPENCODEZ_CACHE_PATH,
  OPENCODEZ_EXPOSE_ALL_MODELS, OPENCODEZ_DEFAULT_MODEL, OPENCODEZ_FIRST_EVENT_MS,
  OPENCODEZ_BODY_IDLE_MS, OPENCODEZ_RESPONSES_BODY_IDLE_MS, OPENCODEZ_MAX_ROTATES,
  OPENCODEZ_INCLUDE_REASONING, OPENCODEZ_MAX_BODY_BYTES,
  OPENCODEZ_REQUEST_TIMEOUT_MS, OPENCODEZ_LOG_LEVEL, OPENCODEZ_CONFIG,
  OPENCODEZ_PANEL, OPENCODEZ_STATS_KEEP_DAYS, OPENCODEZ_STATS_PATH

Authentication:
  API auth is ON by default: Agents must send the agent key to /v1, because any
  program on this machine can reach the port. The key is generated into
  ~/.opencodez-free/agent-key.txt and printed at startup.

  Panel auth is OFF by default: the management panel binds to loopback and shows
  only your own service, so it opens without a password. Enable it with
  --panel-auth (key in ~/.opencodez-free/api-key.txt) if the panel is reachable
  by others.

  Neither key lives in config.json. An explicit --agent-key / --api-key (or the
  matching OPENCODEZ_* variable) takes precedence over the stored file.

  /v1 accepts the key as "Authorization: Bearer <key>", a bare
  "Authorization: <key>", or the x-api-key / api-key headers, so any Agent
  client works.

Endpoints:
  GET  /v1/models              The exposed model roster
  GET  /v1/models/<id>         One model
  POST /v1/chat/completions    Chat Completions (streaming and non-streaming)
  POST /v1/responses           Responses API (streaming and non-streaming)
  GET  /healthz                Health and catalog diagnostics
  GET  /panel/                 Management panel
`
