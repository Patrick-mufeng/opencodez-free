import { isResponsesModel } from './gate.ts'
import { emptyAggregate, foldChatChunk, type AggregatedChat } from './openai.ts'

/**
 * Responses API <-> Chat Completions translation.
 *
 * Zen's `/v1/responses` endpoint only accepts the Responses-only models
 * (`muse-spark-*`); every other model rejects it with
 * `ModelProtocolUnsupported` (probed 2026-10-08). So a Responses-API client
 * talking to a chat model is served by translating the request to Chat
 * Completions upstream and rendering the result back in Responses shape. That
 * keeps one local endpoint usable no matter which free model is selected.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether this model must be served through the upstream Responses endpoint. */
export function needsUpstreamResponses(model: string): boolean {
  return isResponsesModel(model)
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
}

/** Content parts of a Responses input item -> chat content blocks. */
function toChatContent(content: unknown): string | Array<Record<string, unknown>> | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: Array<Record<string, unknown>> = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push({ type: 'text', text: raw })
      continue
    }
    if (!isRecord(raw)) continue
    const type = typeof raw.type === 'string' ? raw.type : ''
    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'summary_text') {
      if (typeof raw.text === 'string') parts.push({ type: 'text', text: raw.text })
      continue
    }
    if (type === 'input_image' || type === 'image_url') {
      const url = typeof raw.image_url === 'string' ? raw.image_url : isRecord(raw.image_url) ? raw.image_url.url : undefined
      if (typeof url === 'string' && url.length > 0) parts.push({ type: 'image_url', image_url: { url } })
      continue
    }
    if (type === 'refusal' && typeof raw.refusal === 'string') parts.push({ type: 'text', text: raw.refusal })
  }
  if (parts.length === 0) return null
  if (parts.length === 1 && parts[0]!.type === 'text') return parts[0]!.text as string
  return parts
}

/** Flat Responses tools -> nested chat tools. */
function toChatTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) return undefined
  const out: Array<Record<string, unknown>> = []
  for (const raw of tools) {
    if (!isRecord(raw)) continue
    const type = typeof raw.type === 'string' ? raw.type : 'function'
    if (type !== 'function') continue
    // Accept both the flat Responses shape and the nested chat shape.
    const source = isRecord(raw.function) ? raw.function : raw
    const name = typeof source.name === 'string' ? source.name : ''
    if (name.length === 0) continue
    out.push({
      type: 'function',
      function: {
        name,
        description: typeof source.description === 'string' ? source.description : '',
        parameters: isRecord(source.parameters) ? source.parameters : { type: 'object', properties: {} },
      },
    })
  }
  return out.length > 0 ? out : undefined
}

function toChatToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice === 'auto' || choice === 'none' || choice === 'required' ? choice : undefined
  if (!isRecord(choice)) return undefined
  // {type:'function', name:'x'} -> {type:'function', function:{name:'x'}}
  const name = typeof choice.name === 'string' ? choice.name : isRecord(choice.function) && typeof choice.function.name === 'string' ? choice.function.name : undefined
  if (name) return { type: 'function', function: { name } }
  return undefined
}

/**
 * Convert a Responses request into an equivalent Chat Completions body.
 * Returns the translated body plus the original `stream` intent.
 */
export function responsesToChat(body: Record<string, unknown>): Record<string, unknown> {
  const messages: ChatMessage[] = []

  if (typeof body.instructions === 'string' && body.instructions.trim().length > 0) {
    messages.push({ role: 'system', content: body.instructions })
  }

  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      if (typeof raw === 'string') {
        messages.push({ role: 'user', content: raw })
        continue
      }
      if (!isRecord(raw)) continue
      const type = typeof raw.type === 'string' ? raw.type : ''

      // A bare input item may be a function call or its output.
      if (type === 'function_call') {
        const callId = typeof raw.call_id === 'string' ? raw.call_id : typeof raw.id === 'string' ? raw.id : ''
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: {
                name: typeof raw.name === 'string' ? raw.name : '',
                arguments: typeof raw.arguments === 'string' ? raw.arguments : JSON.stringify(raw.arguments ?? {}),
              },
            },
          ],
        })
        continue
      }
      if (type === 'function_call_output') {
        const callId = typeof raw.call_id === 'string' ? raw.call_id : ''
        const output = raw.output
        const content =
          typeof output === 'string'
            ? output
            : Array.isArray(output)
              ? output
                  .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : typeof part === 'string' ? part : ''))
                  .join('')
              : JSON.stringify(output ?? '')
        messages.push({ role: 'tool', tool_call_id: callId, content })
        continue
      }
      if (type === 'reasoning' || type === 'item_reference') continue

      const role = typeof raw.role === 'string' ? raw.role : 'user'
      const content = toChatContent(raw.content)
      if (role === 'assistant') {
        const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : []
        if (toolCalls.length > 0) {
          messages.push({ role: 'assistant', content, tool_calls: toolCalls as ChatMessage['tool_calls'] })
        } else if (content !== null) {
          messages.push({ role: 'assistant', content })
        }
        continue
      }
      if (role === 'tool') {
        const callId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : ''
        messages.push({ role: 'tool', tool_call_id: callId, content: typeof content === 'string' ? content : JSON.stringify(content ?? '') })
        continue
      }
      if (role === 'system' || role === 'developer') {
        if (content !== null) messages.push({ role: 'system', content })
        continue
      }
      if (content !== null) messages.push({ role: 'user', content })
    }
  }

  const chat: Record<string, unknown> = { messages }
  if (typeof body.model === 'string') chat.model = body.model
  if (body.stream === true) chat.stream = true

  const tools = toChatTools(body.tools)
  if (tools) chat.tools = tools
  const toolChoice = toChatToolChoice(body.tool_choice)
  if (toolChoice !== undefined) chat.tool_choice = toolChoice

  // Token budget: Responses uses max_output_tokens, chat uses max_tokens.
  const maxOut = body.max_output_tokens ?? body.max_completion_tokens
  if (typeof maxOut === 'number' && maxOut > 0) chat.max_tokens = maxOut
  if (typeof body.temperature === 'number') chat.temperature = body.temperature
  if (typeof body.top_p === 'number') chat.top_p = body.top_p

  // Reasoning effort: {reasoning:{effort}} or {reasoning_effort}.
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined
  const effort = typeof reasoning?.effort === 'string' ? reasoning.effort : typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined
  if (effort !== undefined) chat.reasoning_effort = effort === 'none' ? 'off' : effort

  return chat
}

// ---------------------------------------------------------------------------
// Chat stream -> Responses event stream
// ---------------------------------------------------------------------------

export interface ResponsesEmitter {
  /** Convert one aggregated chunk into zero or more Responses SSE frames. */
  push(data: string): string[]
  /** Emit the terminal events and return them. */
  finish(): string[]
  /** Emit a terminal failure event. */
  fail(message: string): string[]
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
}

function responseEnvelope(aggregate: AggregatedChat, status: string, output: unknown[]): Record<string, unknown> {
  const usage = aggregate.usage
  const prompt = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const completion = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0
  return {
    id: aggregate.id.length > 0 ? aggregate.id : `resp_${Math.random().toString(16).slice(2, 18)}`,
    object: 'response',
    created_at: aggregate.created,
    status,
    model: aggregate.model,
    output,
    output_text: aggregate.content,
    usage: {
      input_tokens: prompt,
      output_tokens: completion,
      total_tokens: typeof usage?.total_tokens === 'number' ? usage.total_tokens : prompt + completion,
      ...(usage?.prompt_tokens_details ? { input_tokens_details: usage.prompt_tokens_details } : {}),
      ...(usage?.completion_tokens_details ? { output_tokens_details: usage.completion_tokens_details } : {}),
    },
  }
}

/**
 * Renders a folded chat stream as Responses events. Text deltas stream through
 * immediately; reasoning is surfaced as summary deltas; tool calls become
 * function_call items.
 */
export class ChatToResponses implements ResponsesEmitter {
  readonly #aggregate: AggregatedChat
  #sequence = 0
  #started = false
  #textItemId = `msg_${Math.random().toString(16).slice(2, 18)}`
  #reasoningItemId = `rs_${Math.random().toString(16).slice(2, 18)}`
  #emittedTextLength = 0
  #emittedReasoningLength = 0
  #sawReasoning = false
  #sawText = false
  #completed = false
  readonly #toolItemIds = new Map<number, string>()
  readonly #emittedArgs = new Map<number, number>()
  readonly #includeReasoning: boolean

  constructor(aggregate: AggregatedChat, options: { includeReasoning?: boolean } = {}) {
    this.#aggregate = aggregate
    this.#includeReasoning = options.includeReasoning !== false
  }

  #nextSequence(): number {
    return this.#sequence++
  }

  #created(): string {
    const envelope = responseEnvelope(this.#aggregate, 'in_progress', [])
    return sse({ type: 'response.created', sequence_number: this.#nextSequence(), response: envelope })
  }

  push(data: string): string[] {
    let touched = false
    try {
      touched = foldChatChunk(this.#aggregate, data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return [
        sse({
          type: 'response.failed',
          sequence_number: this.#nextSequence(),
          response: { ...responseEnvelope(this.#aggregate, 'failed', []), error: { code: 'upstream_error', message } },
        }),
      ]
    }
    if (!touched && this.#aggregate.usage === null) return []

    const frames: string[] = []
    if (!this.#started) {
      this.#started = true
      frames.push(this.#created())
    }

    // Reasoning summary deltas.
    if (this.#includeReasoning && this.#aggregate.reasoning.length > this.#emittedReasoningLength) {
      const delta = this.#aggregate.reasoning.slice(this.#emittedReasoningLength)
      this.#emittedReasoningLength = this.#aggregate.reasoning.length
      if (!this.#sawReasoning) {
        this.#sawReasoning = true
        frames.push(
          sse({
            type: 'response.output_item.added',
            sequence_number: this.#nextSequence(),
            output_index: 0,
            item: { id: this.#reasoningItemId, type: 'reasoning', summary: [] },
          }),
        )
      }
      frames.push(
        sse({
          type: 'response.reasoning_summary_text.delta',
          sequence_number: this.#nextSequence(),
          item_id: this.#reasoningItemId,
          output_index: 0,
          summary_index: 0,
          delta,
        }),
      )
    }

    // Text deltas.
    if (this.#aggregate.content.length > this.#emittedTextLength) {
      const delta = this.#aggregate.content.slice(this.#emittedTextLength)
      this.#emittedTextLength = this.#aggregate.content.length
      if (!this.#sawText) {
        this.#sawText = true
        const outputIndex = this.#sawReasoning ? 1 : 0
        frames.push(
          sse({
            type: 'response.output_item.added',
            sequence_number: this.#nextSequence(),
            output_index: outputIndex,
            item: { id: this.#textItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          }),
        )
        frames.push(
          sse({
            type: 'response.content_part.added',
            sequence_number: this.#nextSequence(),
            item_id: this.#textItemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          }),
        )
      }
      frames.push(
        sse({
          type: 'response.output_text.delta',
          sequence_number: this.#nextSequence(),
          item_id: this.#textItemId,
          output_index: this.#sawReasoning ? 1 : 0,
          content_index: 0,
          delta,
        }),
      )
    }

    // Tool call deltas.
    this.#aggregate.toolCalls.forEach((call, index) => {
      if (call.function.name.length === 0) return
      const outputIndex = (this.#sawReasoning ? 1 : 0) + (this.#sawText ? 1 : 0) + index
      if (!this.#toolItemIds.has(index)) {
        const itemId = call.id.length > 0 ? call.id : `fc_${Math.random().toString(16).slice(2, 18)}`
        this.#toolItemIds.set(index, itemId)
        this.#emittedArgs.set(index, 0)
        frames.push(
          sse({
            type: 'response.output_item.added',
            sequence_number: this.#nextSequence(),
            output_index: outputIndex,
            item: { id: itemId, type: 'function_call', status: 'in_progress', name: call.function.name, arguments: '', call_id: itemId },
          }),
        )
      }
      const emitted = this.#emittedArgs.get(index) ?? 0
      if (call.function.arguments.length > emitted) {
        const delta = call.function.arguments.slice(emitted)
        this.#emittedArgs.set(index, call.function.arguments.length)
        frames.push(
          sse({
            type: 'response.function_call_arguments.delta',
            sequence_number: this.#nextSequence(),
            item_id: this.#toolItemIds.get(index),
            output_index: outputIndex,
            delta,
          }),
        )
      }
    })

    return frames
  }

  /** Close open items and emit the terminal `response.completed` event. */
  finish(): string[] {
    if (this.#completed) return []
    this.#completed = true
    const frames: string[] = []
    if (!this.#started) {
      this.#started = true
      frames.push(this.#created())
    }

    const output: Array<Record<string, unknown>> = []
    if (this.#sawReasoning) {
      output.push({
        id: this.#reasoningItemId,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: this.#aggregate.reasoning }],
      })
    }
    if (this.#sawText) {
      const outputIndex = this.#sawReasoning ? 1 : 0
      frames.push(
        sse({
          type: 'response.output_text.done',
          sequence_number: this.#nextSequence(),
          item_id: this.#textItemId,
          output_index: outputIndex,
          content_index: 0,
          text: this.#aggregate.content,
        }),
      )
      frames.push(
        sse({
          type: 'response.content_part.done',
          sequence_number: this.#nextSequence(),
          item_id: this.#textItemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: this.#aggregate.content, annotations: [] },
        }),
      )
      frames.push(
        sse({
          type: 'response.output_item.done',
          sequence_number: this.#nextSequence(),
          output_index: outputIndex,
          item: {
            id: this.#textItemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: this.#aggregate.content, annotations: [] }],
          },
        }),
      )
      output.push({
        id: this.#textItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.#aggregate.content, annotations: [] }],
      })
    }

    this.#aggregate.toolCalls.forEach((call, index) => {
      if (call.function.name.length === 0) return
      const itemId = this.#toolItemIds.get(index) ?? `fc_${Math.random().toString(16).slice(2, 18)}`
      const outputIndex = (this.#sawReasoning ? 1 : 0) + (this.#sawText ? 1 : 0) + index
      const item = {
        id: itemId,
        type: 'function_call',
        status: 'completed',
        name: call.function.name,
        arguments: call.function.arguments.length > 0 ? call.function.arguments : '{}',
        call_id: itemId,
      }
      frames.push(
        sse({
          type: 'response.function_call_arguments.done',
          sequence_number: this.#nextSequence(),
          item_id: itemId,
          output_index: outputIndex,
          arguments: item.arguments,
        }),
      )
      frames.push(sse({ type: 'response.output_item.done', sequence_number: this.#nextSequence(), output_index: outputIndex, item }))
      output.push(item)
    })

    const hasTools = output.some((item) => item.type === 'function_call')
    const status = this.#aggregate.finishReason === 'length' ? 'incomplete' : 'completed'
    frames.push(
      sse({
        type: 'response.completed',
        sequence_number: this.#nextSequence(),
        response: {
          ...responseEnvelope(this.#aggregate, status, output),
          ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
          ...(hasTools ? {} : {}),
        },
      }),
    )
    return frames
  }

  /** Terminal failure, for a stream that died before a completed event. */
  fail(message: string): string[] {
    if (this.#completed) return []
    this.#completed = true
    return [
      sse({
        type: 'response.failed',
        sequence_number: this.#nextSequence(),
        response: {
          ...responseEnvelope(this.#aggregate, 'failed', []),
          error: { code: 'upstream_error', message },
        },
      }),
    ]
  }
}

/** Build a whole Responses object from an aggregated chat stream. */
export function chatToResponsesObject(aggregate: AggregatedChat, options: { includeReasoning?: boolean } = {}): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = []
  if (options.includeReasoning !== false && aggregate.hadReasoning && aggregate.reasoning.length > 0) {
    output.push({
      id: `rs_${Math.random().toString(16).slice(2, 18)}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: aggregate.reasoning }],
    })
  }
  if (aggregate.content.length > 0 || aggregate.toolCalls.length === 0) {
    output.push({
      id: `msg_${Math.random().toString(16).slice(2, 18)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: aggregate.content, annotations: [] }],
    })
  }
  for (const call of aggregate.toolCalls) {
    if (call.function.name.length === 0) continue
    const itemId = call.id.length > 0 ? call.id : `fc_${Math.random().toString(16).slice(2, 18)}`
    output.push({
      id: itemId,
      type: 'function_call',
      status: 'completed',
      name: call.function.name,
      arguments: call.function.arguments.length > 0 ? call.function.arguments : '{}',
      call_id: itemId,
    })
  }
  const status = aggregate.finishReason === 'length' ? 'incomplete' : 'completed'
  return {
    ...responseEnvelope(aggregate, status, output),
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  }
}

export { emptyAggregate }
