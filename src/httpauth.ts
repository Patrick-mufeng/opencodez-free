import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

/**
 * Client credential extraction, shared by the API surface and the panel.
 *
 * Clients disagree on how to carry a key, and an agent integration that sends
 * `x-api-key` must not be turned away just because OpenAI's own SDK uses
 * `Authorization: Bearer`. All of these are accepted (live-checked):
 *
 *   Authorization: Bearer <key>   the OpenAI convention
 *   Authorization: <key>          a bare value, sent by some gateways
 *   x-api-key: <key>              Anthropic-style clients and proxies
 *   api-key: <key>                Azure-style
 */

/** Header names checked when Authorization carries nothing usable. */
export const API_KEY_HEADERS = ['x-api-key', 'api-key'] as const

function headerValue(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim()
  return ''
}

/**
 * The key a request presents, or an empty string. A bare Authorization value is
 * returned as-is so a client that omits the `Bearer` prefix still authenticates.
 */
export function extractToken(headers: IncomingHttpHeaders): string {
  const authorization = headerValue(headers.authorization)
  if (authorization.length > 0) {
    if (authorization.toLowerCase().startsWith('bearer ')) {
      const bearer = authorization.slice(7).trim()
      if (bearer.length > 0) return bearer
      // `Authorization: Bearer ` with nothing after it is an absent credential,
      // not a token literally spelled "Bearer" — fall through to the other
      // headers instead of returning the scheme.
    } else if (authorization.toLowerCase() !== 'bearer') {
      return authorization
    }
  }
  for (const name of API_KEY_HEADERS) {
    const value = headerValue(headers[name])
    if (value.length > 0) return value
  }
  return ''
}

/** Constant-time comparison; a length mismatch short-circuits without leaking. */
export function tokenMatches(provided: string, expected: string): boolean {
  if (expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
