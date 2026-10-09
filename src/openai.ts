/**
 * The OpenAI compatibility layer.
 *
 * The upstream free lane refuses `stream:false` outright (probed 2026-10-08),
 * so a non-streaming client is served by streaming internally and aggregating
 * the deltas back into a single completion object here.
 */

export interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: Record<string, unknown>
  completion_tokens_details?: Record<string, unknown>
  [key: string]: unknown
}

export interface AggregatedChat {
  id: string
  created: number
  model: string
  content: string
  reasoning: string
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  finishReason: string | null
  usage: ChatUsage | null
  hadReasoning: boolean
}

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function emptyAggregate(model: string): AggregatedChat {
  return {
    id: '',
    created: Math.floor(Date.now() / 1000),
    model,
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: null,
    usage: null,
    hadReasoning: false,
  }
}

function mergeToolName(current: string, fragment: string): string {
  if (current === '' || fragment === current) return fragment
  if (fragment.startsWith(current)) return fragment
  if (current.endsWith(fragment)) return current
  return current + fragment
}

/**
 * Fold one upstream `chat.completion.chunk` payload into the aggregate. Returns
 * false when the payload is not a chunk (so callers can ignore it).
 */
export function foldChatChunk(aggregate: AggregatedChat, data: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false

  // Some upstreams deliver an error object on the stream instead of a chunk.
  if (isRecord(parsed.error)) {
    const message = typeof parsed.error.message === 'string' ? parsed.error.message : 'upstream stream error'
    throw new Error(message)
  }

  if (typeof parsed.id === 'string' && parsed.id.length > 0 && aggregate.id === '') aggregate.id = parsed.id
  if (typeof parsed.created === 'number') aggregate.created = parsed.created
  if (typeof parsed.model === 'string' && parsed.model.length > 0) aggregate.model = parsed.model
  if (isRecord(parsed.usage)) aggregate.usage = parsed.usage as ChatUsage

  const choices = Array.isArray(parsed.choices) ? parsed.choices : []
  let touched = false
  for (const rawChoice of choices) {
    if (!isRecord(rawChoice)) continue
    touched = true
    const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {}

    const reasoning = delta.reasoning ?? delta.reasoning_content
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      aggregate.reasoning += reasoning
      aggregate.hadReasoning = true
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) aggregate.content += delta.content

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const rawCall of toolCalls) {
      if (!isRecord(rawCall)) continue
      const index = typeof rawCall.index === 'number' ? rawCall.index : aggregate.toolCalls.length
      while (aggregate.toolCalls.length <= index) {
        aggregate.toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
      }
      const slot = aggregate.toolCalls[index]!
      if (typeof rawCall.id === 'string' && rawCall.id.length > 0) slot.id = rawCall.id
      const fn = isRecord(rawCall.function) ? rawCall.function : {}
      if (typeof fn.name === 'string' && fn.name.length > 0) slot.function.name = mergeToolName(slot.function.name, fn.name)
      if (typeof fn.arguments === 'string' && fn.arguments.length > 0) slot.function.arguments += fn.arguments
    }

    if (typeof rawChoice.finish_reason === 'string' && rawChoice.finish_reason.length > 0) {
      aggregate.finishReason = rawChoice.finish_reason
    }
  }
  return touched
}

/** Build the non-streaming `chat.completion` object from an aggregate. */
export function toChatCompletion(aggregate: AggregatedChat): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant' }
  const hasTools = aggregate.toolCalls.length > 0 && aggregate.toolCalls.some((call) => call.function.name.length > 0)
  // OpenAI uses null content alongside tool calls.
  message.content = aggregate.content.length > 0 ? aggregate.content : hasTools ? null : ''

  if (hasTools) {
    message.tool_calls = aggregate.toolCalls.map((call) => ({
      id: call.id.length > 0 ? call.id : `call_${Math.random().toString(16).slice(2, 18)}`,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments.length > 0 ? call.function.arguments : '{}' },
    }))
  }
  // Both spellings: `reasoning` is what upstream sends, `reasoning_content` is
  // what DeepSeek-style clients read.
  if (aggregate.hadReasoning) {
    message.reasoning = aggregate.reasoning
    message.reasoning_content = aggregate.reasoning
  }

  const finishReason = aggregate.finishReason ?? (hasTools ? 'tool_calls' : 'stop')
  const completion: Record<string, unknown> = {
    id: aggregate.id.length > 0 ? aggregate.id : `chatcmpl_${Math.random().toString(16).slice(2, 18)}`,
    object: 'chat.completion',
    created: aggregate.created,
    model: aggregate.model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finishReason === 'tool_calls' && !hasTools ? 'stop' : finishReason,
      },
    ],
  }
  completion.usage =
    aggregate.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    }
  return completion
}

/**
 * Rewrite one chat chunk for client compatibility. Upstream reports reasoning
 * in `delta.reasoning`; DeepSeek-style clients read `reasoning_content`, so
 * both are populated. With `reasoningAlias: false` the reasoning fields are
 * stripped instead, for callers that do not want thinking in their stream.
 * Returns the original string when nothing needs changing.
 */
export function rewriteChatChunk(data: string, options: { reasoningAlias?: boolean } = {}): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return data
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return data
  const alias = options.reasoningAlias !== false
  let changed = false
  for (const choice of parsed.choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue
    const delta = choice.delta
    if (!alias) {
      if (delta.reasoning !== undefined || delta.reasoning_content !== undefined || delta.reasoning_details !== undefined) {
        delete delta.reasoning
        delete delta.reasoning_content
        delete delta.reasoning_details
        changed = true
      }
      continue
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0 && delta.reasoning_content === undefined) {
      delta.reasoning_content = delta.reasoning
      changed = true
    }
    if (delta.reasoning === null && delta.reasoning_content === undefined) {
      delta.reasoning_content = null
      changed = true
    }
  }
  return changed ? JSON.stringify(parsed) : data
}

// ---------------------------------------------------------------------------
// Responses API aggregation
// ---------------------------------------------------------------------------

export interface AggregatedResponses {
  id: string
  createdAt: number
  model: string
  text: string
  reasoning: string
  status: string
  usage: Record<string, unknown> | null
  /** The full response object from the terminal event, when upstream sent one. */
  final: Record<string, unknown> | null
  error: { message: string; code?: string } | null
}

export function emptyResponsesAggregate(model: string): AggregatedResponses {
  return {
    id: '',
    createdAt: Math.floor(Date.now() / 1000),
    model,
    text: '',
    reasoning: '',
    status: 'in_progress',
    usage: null,
    final: null,
    error: null,
  }
}

/**
 * Fold one Responses event. The OpenAI Responses vocabulary names events by
 * `type` with the payload under the same key; the terminal `response.completed`
 * / `response.failed` event carries a whole response object, which is used
 * verbatim when present.
 */
export function foldResponsesEvent(aggregate: AggregatedResponses, eventName: string, data: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }
  if (!isRecord(parsed)) return
  const type = typeof parsed.type === 'string' ? parsed.type : eventName

  if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') aggregate.text += parsed.delta
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    if (typeof parsed.delta === 'string') aggregate.reasoning += parsed.delta
  }
  if (type === 'response.created' && isRecord(parsed.response)) {
    if (typeof parsed.response.id === 'string') aggregate.id = parsed.response.id
    if (typeof parsed.response.model === 'string') aggregate.model = parsed.response.model
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    if (isRecord(parsed.response)) {
      aggregate.final = parsed.response
      if (typeof parsed.response.status === 'string') aggregate.status = parsed.response.status
      if (isRecord(parsed.response.usage)) aggregate.usage = parsed.response.usage
      if (typeof parsed.response.id === 'string' && parsed.response.id.length > 0) aggregate.id = parsed.response.id
    } else {
      aggregate.status = type === 'response.completed' ? 'completed' : 'failed'
    }
    if (type === 'response.failed') {
      const error = isRecord(parsed.response) && isRecord(parsed.response.error) ? parsed.response.error : null
      aggregate.error = {
        message: error && typeof error.message === 'string' ? error.message : 'upstream response failed',
        ...(error && typeof error.code === 'string' ? { code: error.code } : {}),
      }
    }
  }
  if (type === 'error' || type === 'response.error') {
    const error = isRecord(parsed.error) ? parsed.error : parsed
    aggregate.error = { message: typeof error.message === 'string' ? error.message : 'upstream stream error' }
  }
}

/** Build a non-streaming Responses object when upstream sent no terminal copy. */
export function toResponsesObject(aggregate: AggregatedResponses): Record<string, unknown> {
  if (aggregate.final) return aggregate.final
  return {
    id: aggregate.id.length > 0 ? aggregate.id : `resp_${Math.random().toString(16).slice(2, 18)}`,
    object: 'response',
    created_at: aggregate.createdAt,
    status: aggregate.status === 'in_progress' ? 'completed' : aggregate.status,
    model: aggregate.model,
    output: [
      {
        type: 'message',
        id: `msg_${Math.random().toString(16).slice(2, 18)}`,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: aggregate.text, annotations: [] }],
      },
    ],
    output_text: aggregate.text,
    usage: aggregate.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  }
}
