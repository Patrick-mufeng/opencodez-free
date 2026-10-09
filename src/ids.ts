import { createHash, randomBytes } from 'node:crypto'

/**
 * Correlation identity for upstream requests. Ported from the DSH plugin's
 * adapter/ids.ts (itself a port of opencode2api's ids.go).
 *
 * The anonymous lane checks this identity: since 2026-09-16 Zen rejects any
 * x-opencode-session that is not the canonical `ses_<12 hex><14 base62>` shape
 * with a 403 FreeTierError, so a plain user-agent is not enough on its own.
 */

export interface RequestIDs {
  session: string
  request: string
  project: string
}

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/**
 * Deterministically fold any signal into OpenCode's canonical session shape.
 * A value that already carries the official shape passes through unchanged so
 * upstream prompt-cache affinity is preserved.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const timePart = sum.subarray(0, 6).toString('hex')
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  return `ses_${timePart}${randomPart}`
}

/**
 * The conversation signal: JSON of the first user message's content. Keying on
 * the first user turn keeps a conversation stable as its history grows while
 * still separating conversations with different beginnings.
 */
export function conversationSeed(messages: Array<{ role?: string; content?: unknown }>): string {
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0 && encoded !== '""') return encoded
  }
  return ''
}

export interface DeriveOptions {
  /** Explicit session override (the x-opencode-session request header). */
  session?: string
}

/** Derive the correlation ids for one upstream request. */
export function deriveRequestIDs(
  messages: Array<{ role?: string; content?: unknown }>,
  options: DeriveOptions = {},
): RequestIDs {
  const explicit = options.session?.trim()
  const signal = explicit && explicit.length > 0 ? explicit : conversationSeed(messages)
  const seed = signal.length > 0 && signal !== '{}' ? signal : randomID('fallback', 16)
  return {
    session: canonicalSessionID(seed),
    request: randomID('req', 16),
    project: stableID('prj', 'opencodez-free:default-project'),
  }
}

/** CLI-identical user agent, node runtime values. */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/** The full disguise header set sent with every upstream request. */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
