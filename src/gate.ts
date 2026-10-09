/**
 * Requests must look like an agent to the anonymous lane: the body needs
 * function tools literally named "bash" and "read" (probed 2026-10-08 — a body
 * with neither is refused with HTTP 403 FreeTierError, and `stream:false` is
 * refused too regardless of tools).
 *
 * Ported from the DSH plugin's adapter/messages.ts. The gate tools are appended
 * only when missing, and with `tool_choice: 'none'` when the caller supplied no
 * tools at all, so an injected stub is never actually invoked.
 */

export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'] as const

export interface FreeLaneGateTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export function freeLaneGateTool(name: (typeof FREE_LANE_GATE_TOOL_NAMES)[number]): FreeLaneGateTool {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Chat Completions path: append the missing gate tools. Returns undefined when
 * the payload already satisfies the gate (or is not a chat body), letting the
 * caller keep its original object.
 */
export function ensureChatFreeLaneShape(payload: unknown): unknown | undefined {
  if (!isRecord(payload)) return undefined
  const body = payload
  if (!Array.isArray(body.messages)) return undefined
  const tools = Array.isArray(body.tools) ? body.tools : []
  const names = new Set(
    tools.map((tool) => {
      const fn = isRecord(tool) ? tool.function : undefined
      return isRecord(fn) ? fn.name : undefined
    }),
  )
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name))
  if (missing.length === 0) return undefined
  const next: Record<string, unknown> = { ...body }
  next.tools = [...tools, ...missing.map((name) => freeLaneGateTool(name))]
  // Only a body the caller sent without tools gets tool_choice forced; an
  // explicit caller-provided choice must survive untouched.
  if (tools.length === 0) next.tool_choice = 'none'
  return next
}

/** Responses path: flat function tools, and the Zen gateway accepts `auto` only. */
export function ensureResponsesFreeLaneShape(payload: unknown): unknown | undefined {
  if (!isRecord(payload)) return undefined
  const body = payload
  // The Responses API accepts a bare string as `input`; normalize it to the
  // array form so the gate below still applies. Skipping it would leave such a
  // request without the bash/read tools, which upstream refuses.
  const stringInput = typeof body.input === 'string'
  const input = stringInput ? [{ role: 'user', content: body.input }] : body.input
  if (!Array.isArray(input)) return undefined
  const tools = Array.isArray(body.tools) ? body.tools : []
  const names = new Set(
    tools.map((tool) => {
      if (!isRecord(tool)) return undefined
      return tool.type === 'function' ? tool.name : undefined
    }),
  )
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name))
  const invalidChoice = body.tool_choice !== undefined && body.tool_choice !== 'auto'
  if (missing.length === 0 && !invalidChoice && !stringInput) return undefined
  return {
    ...body,
    input,
    tools: [...tools, ...missing.map((name) => ({ type: 'function', ...freeLaneGateTool(name).function }))],
    tool_choice: 'auto',
  }
}

/** Models that only answer on the Responses endpoint (live-verified). */
export const RESPONSES_ONLY_PREFIX = 'muse-spark'

export function isResponsesModel(id: string): boolean {
  return String(id ?? '').toLowerCase().startsWith(RESPONSES_ONLY_PREFIX)
}

export function apiForModel(id: string): 'openai-responses' | 'openai-completions' {
  return isResponsesModel(id) ? 'openai-responses' : 'openai-completions'
}

/**
 * The `reasoning_effort` wire values the gateway accepts. Probed 2026-10-08:
 * any other value is a hard 400 listing exactly this set.
 */
export const REASONING_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const WIRE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'] as const

/**
 * Selected effort id -> wire value. `off` must be SENT as `none` rather than
 * omitted: omission leaves the always-think free models thinking. Unknown ids
 * inject nothing rather than risk the 400.
 */
export function reasoningEffortWire(id: string | undefined): string | undefined {
  if (id === undefined || id === null) return undefined
  if (id === 'off') return 'none'
  return (WIRE_EFFORTS as readonly string[]).includes(id) ? id : undefined
}

/** models.dev-declared effort values -> advertised effort ids (`none` -> `off`). */
export function toEffortIDs(effortValues: string[] | undefined): string[] {
  if (!effortValues) return []
  const out: string[] = []
  for (const value of effortValues) {
    const level = value === 'none' ? 'off' : value
    if ((REASONING_EFFORT_LADDER as readonly string[]).includes(level) && !out.includes(level)) out.push(level)
  }
  return out.sort(
    (a, b) => (REASONING_EFFORT_LADDER as readonly string[]).indexOf(a) - (REASONING_EFFORT_LADDER as readonly string[]).indexOf(b),
  )
}
