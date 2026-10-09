import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { opencodeUserAgent } from './ids.ts'

/**
 * Model directory with a three-tier fallback chain, ported from the DSH
 * plugin's adapter/catalog.ts (itself a port of opencode2api's models.go +
 * model_metadata.go):
 *
 *   S1  GET {zen}/v1/models         live catalog (free and paid ids)
 *   S2  GET https://models.dev/api.json  pricing metadata -> the free decision
 *   S3  a compile-time verified list     last-resort bootstrap
 *
 * Exposed roster = S1 ∩ S2-allowed, or S3 while S1 is still pending. A disk
 * cache covers upstream outages.
 */

export const ZEN_BASE_URL = 'https://opencode.ai/zen'
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/**
 * Bootstrap list, live-verified against the anonymous lane. Only used before
 * the first successful S1 fetch: the live roster rotates constantly and this
 * list is not meant to track it.
 */
export const staticFreeModels: string[] = [
  'mimo-v2.6-flash-free',
  'ling-3.0-flash-fin-free',
  'ling-3.1-flash-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3-ultra-free',
  'step-5-preview-free',
  'muse-spark-1.2-contributor-free',
]

export function isFreeModel(model: string): boolean {
  return model.toLowerCase().includes('free')
}

export interface AnonymousDecision {
  allowed: boolean
  source: string
  known: boolean
}

export interface ModelPrice {
  input?: number
  output?: number
  deprecated: boolean
  reasoning?: boolean
  effortValues?: string[]
  contextWindow?: number
  maxOutput?: number
  modalities?: string[]
}

/**
 * Decide whether the anonymous lane may serve a model.
 *
 * A ready metadata verdict always wins (including `deprecated`); the
 * name-contains-"free" fallback only fires when metadata cannot speak. The
 * upstream short-circuits on the name first, which keeps delisted ids exposed
 * forever; this order fixes that.
 */
export function decide(model: string, prices: Map<string, ModelPrice>, ready: boolean): AnonymousDecision {
  const nameFree = isFreeModel(model)
  const fallback = (source: string): AnonymousDecision =>
    nameFree ? { allowed: true, source: 'name_free', known: false } : { allowed: false, source, known: false }

  if (!ready || prices.size === 0) return fallback('metadata_pending')
  const price = prices.get(model)
  if (!price) return fallback('metadata_model_missing')
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true }
  if (price.input === 0 && price.output === 0) {
    return { allowed: true, source: nameFree ? 'name_and_metadata_free' : 'metadata_free', known: true }
  }
  if (price.input === undefined || price.output === undefined) {
    return { allowed: false, source: 'metadata_cost_unknown', known: false }
  }
  return { allowed: false, source: 'metadata_paid', known: true }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function metadataDeprecated(model: Record<string, unknown>): boolean {
  if (model.deprecated === true) return true
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase()
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true
  return model.deprecated_at != null || model.retirement_date != null
}

/**
 * models.dev `reasoning_options`: an array of `{type:"effort",values:[...]}`,
 * `{type:"toggle"}` or `{type:"budget_tokens",...}`. Only `effort` entries
 * carry selectable levels; the others mean "reasons, no declared ladder".
 */
function decodeEffortValues(raw: unknown): { effortValues?: string[] } {
  if (!Array.isArray(raw)) return {}
  const values: string[] = []
  for (const option of raw) {
    if (typeof option !== 'object' || option === null) continue
    const entry = option as { type?: unknown; values?: unknown }
    if (entry.type !== 'effort' || !Array.isArray(entry.values)) continue
    for (const value of entry.values) {
      if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value)
    }
  }
  return { effortValues: values }
}

function decodeModalities(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const kinds: string[] = []
  for (const kind of input) {
    if (typeof kind === 'string' && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds.length > 0 ? kinds : undefined
}

/** Read the OpenCode section of models.dev, preferring the exact provider key. */
export function decodeModelsDev(data: unknown): Map<string, ModelPrice> {
  const result = new Map<string, ModelPrice>()
  if (!data || typeof data !== 'object') return result
  const providers = data as Record<string, { models?: Record<string, Record<string, unknown>>; id?: unknown; name?: unknown }>
  const rank = (key: string): number => {
    const lower = key.toLowerCase()
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0
    if (lower.includes('opencode')) return 1
    return 2
  }
  const keys = Object.keys(providers).sort((left, right) => {
    const diff = rank(left) - rank(right)
    return diff !== 0 ? diff : left.localeCompare(right)
  })
  for (const key of keys) {
    if (rank(key) > 1) continue
    const provider = providers[key]
    if (!provider || typeof provider !== 'object') continue
    if (rank(key) === 1) {
      const identity = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim()
      if (!identity.includes('opencode')) continue
    }
    const models = provider.models
    if (!models || typeof models !== 'object') continue
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey
      const cost = (raw.cost ?? {}) as Record<string, unknown>
      const limit = (raw.limit ?? {}) as Record<string, unknown>
      const modalities = (raw.modalities ?? {}) as Record<string, unknown>
      const contextWindow = num(limit.context)
      const maxOutput = num(limit.output)
      const inputModalities = decodeModalities(modalities.input)
      const effort = decodeEffortValues(raw.reasoning_options)
      result.set(modelId, {
        input: num(cost.input),
        output: num(cost.output),
        deprecated: metadataDeprecated(raw),
        reasoning: raw.reasoning === true,
        ...(effort.effortValues !== undefined ? { effortValues: effort.effortValues } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
        ...(inputModalities !== undefined ? { modalities: inputModalities } : {}),
      })
    }
    if (result.size > 0) return result
  }
  return result
}

export interface CatalogSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'error'
  total: number
  exposed: number
  lastRefresh?: string
}

export interface CatalogOptions {
  refreshSeconds?: number
  cachePath?: string
  zenBaseUrl?: string
  metadataUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  startupRetryMs?: number
  startupRetries?: number
  onRefresh?: (snapshot: CatalogSnapshot, lastError: string) => void
  timeoutMs?: number
}

const METADATA_REFRESH_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** S1: the live roster, requested with the CLI disguise headers. */
export async function fetchZenModels(
  zenBaseUrl: string,
  fetchImpl: typeof fetch,
  userAgent: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string[]> {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${zenBaseUrl.replace(/\/+$/, '')}/v1/models`,
    {
      headers: {
        authorization: 'Bearer public',
        'user-agent': userAgent,
        'x-opencode-client': 'cli',
        accept: 'application/json',
      },
    },
    timeoutMs,
  )
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
  const models: string[] = []
  for (const item of payload.data ?? []) {
    if (typeof item?.id === 'string' && item.id.length > 0) models.push(item.id)
  }
  if (models.length === 0) throw new Error('models endpoint returned an empty list')
  return models
}

export class ModelCatalog {
  #zen = new Set<string>()
  #updatedAt = 0
  #prices = new Map<string, ModelPrice>()
  #pricesReady = false
  #pricesUpdatedAt = 0
  #lastError = ''
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  readonly #options: Required<Pick<CatalogOptions, 'refreshSeconds' | 'zenBaseUrl' | 'metadataUrl' | 'startupRetryMs' | 'startupRetries' | 'timeoutMs'>> &
    CatalogOptions

  constructor(options: CatalogOptions = {}) {
    this.#options = {
      refreshSeconds: options.refreshSeconds ?? 300,
      zenBaseUrl: options.zenBaseUrl ?? ZEN_BASE_URL,
      metadataUrl: options.metadataUrl ?? MODELS_DEV_URL,
      startupRetryMs: options.startupRetryMs ?? 15_000,
      startupRetries: options.startupRetries ?? 4,
      timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
      ...options,
    }
  }

  get #fetch(): typeof fetch {
    return this.#options.fetchImpl ?? fetch
  }

  get #now(): () => number {
    return this.#options.now ?? Date.now
  }

  /**
   * Immediate S1+S2, fast retries while the live roster is still empty (the
   * first fetch often races the machine's network coming up), then the normal
   * cadence.
   */
  async start(): Promise<void> {
    await this.refreshOnce()
    for (let attempt = 0; this.#zen.size === 0 && attempt < this.#options.startupRetries && !this.#stopped; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.startupRetryMs))
      if (this.#stopped) return
      await this.refreshOnce()
    }
    if (this.#stopped) return
    this.#timer = setInterval(() => void this.refreshOnce(), this.#options.refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  async refreshOnce(): Promise<void> {
    const now = this.#now()
    // Pricing metadata refreshes daily; the live roster follows the cadence.
    const metadataDue = !this.#pricesReady || now - this.#pricesUpdatedAt > METADATA_REFRESH_MS
    await Promise.allSettled([this.refreshZen(), metadataDue ? this.refreshMetadata() : Promise.resolve()])
    if (this.#options.onRefresh) {
      try {
        this.#options.onRefresh(this.snapshot(), this.#lastError)
      } catch {
        // observers must never break the refresh loop
      }
    }
  }

  async refreshZen(): Promise<void> {
    try {
      const ids = await fetchZenModels(this.#options.zenBaseUrl, this.#fetch, opencodeUserAgent(), this.#options.timeoutMs)
      this.#zen = new Set(ids)
      this.#updatedAt = this.#now()
      this.#lastError = ''
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  async refreshMetadata(): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        this.#fetch,
        this.#options.metadataUrl,
        { headers: { accept: 'application/json' } },
        this.#options.timeoutMs,
      )
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
      const prices = decodeModelsDev(await response.json())
      if (prices.size === 0) throw new Error('models.dev contains no OpenCode model metadata')
      this.#prices = prices
      this.#pricesReady = true
      this.#pricesUpdatedAt = this.#now()
      if (this.#options.cachePath) await this.#saveCache(this.#options.cachePath).catch(() => {})
    } catch (err) {
      // A network failure with a usable cache is not fatal.
      if (this.#options.cachePath && !this.#pricesReady) {
        const cached = await this.#loadCache(this.#options.cachePath).catch(() => null)
        if (cached && cached.size > 0) {
          this.#prices = cached
          this.#pricesReady = true
          this.#pricesUpdatedAt = this.#now()
          return
        }
      }
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  async #saveCache(path: string): Promise<void> {
    const payload = JSON.stringify({ updatedAt: this.#now(), prices: [...this.#prices] })
    const tmp = `${path}.${process.pid}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, payload, 'utf8')
    await rm(path, { force: true })
    await rename(tmp, path)
  }

  async #loadCache(path: string): Promise<Map<string, ModelPrice>> {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { updatedAt: number; prices: Array<[string, ModelPrice]> }
    if (Date.now() - raw.updatedAt > 7 * METADATA_REFRESH_MS) throw new Error('models.dev cache too old')
    return new Map(raw.prices)
  }

  decision(model: string): AnonymousDecision {
    const metadata = decide(model, this.#prices, this.#pricesReady)
    // The static list is compile-time verified against the live lane, so it
    // stays vouched even when stale metadata claims deprecation.
    if (!metadata.allowed && staticFreeModels.includes(model)) {
      if (metadata.source === 'metadata_deprecated' || !metadata.known) {
        return { allowed: true, source: 'static_verified', known: false }
      }
    }
    return metadata
  }

  /** Exposed ids: S1 ∩ allowed, or the bootstrap list while S1 is pending. */
  list(): string[] {
    if (this.#zen.size === 0) return [...staticFreeModels]
    const out: string[] = []
    for (const model of this.#zen) {
      if (this.decision(model).allowed) out.push(model)
    }
    return out.sort()
  }

  /**
   * The whole live roster, ungated. The caller decides whether to advertise it
   * (the server's `exposeAllModels`); keeping the switch out of the catalog
   * means there is only ever one place that owns it.
   */
  allModels(): string[] {
    return [...this.#zen].sort()
  }

  limits(model: string): { contextWindow?: number; maxOutput?: number } | undefined {
    const price = this.#prices.get(model)
    if (!price) return undefined
    if (price.contextWindow === undefined && price.maxOutput === undefined) return undefined
    return {
      ...(price.contextWindow !== undefined ? { contextWindow: price.contextWindow } : {}),
      ...(price.maxOutput !== undefined ? { maxOutput: price.maxOutput } : {}),
    }
  }

  modalities(model: string): string[] | undefined {
    const modalities = this.#prices.get(model)?.modalities
    return modalities === undefined ? undefined : [...modalities]
  }

  reasoningCapability(model: string): { reasoning: boolean; effortValues: string[] } | undefined {
    const price = this.#prices.get(model)
    if (!price) return undefined
    return { reasoning: price.reasoning === true, effortValues: price.effortValues ?? [] }
  }

  snapshot(): CatalogSnapshot {
    const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt
    const stale = this.#updatedAt !== 0 && age > Math.max(10 * 60 * 1000, this.#options.refreshSeconds * 2000)
    return {
      status: this.#updatedAt === 0 ? 'pending' : stale ? 'stale' : 'ready',
      total: this.#zen.size,
      exposed: this.list().length,
      ...(this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}),
    }
  }
  get lastError(): string {
    return this.#lastError
  }

  get liveCount(): number {
    return this.#zen.size
  }
}

/** Vision gate: models.dev modalities decide; the built-in pattern is the fallback. */
export function isVisionModel(id: string, declaredModalities?: string[]): boolean {
  if (Array.isArray(declaredModalities) && declaredModalities.length > 0) {
    return declaredModalities.includes('image')
  }
  return /^mimo-v2\.6/i.test(String(id ?? ''))
}
