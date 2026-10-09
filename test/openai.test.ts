import { strict as assert } from 'node:assert'
import test from 'node:test'

import { emptyAggregate, foldChatChunk, rewriteChatChunk, toChatCompletion } from '../src/openai.ts'

const chunk = (payload: unknown): string => JSON.stringify(payload)

test('text deltas accumulate in order', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { content: 'Hel' } }] }))
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { content: 'lo' } }] }))
  assert.equal(aggregate.content, 'Hello')
})

test('both reasoning spellings are captured as one stream', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { reasoning: 'thin' } }] }))
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { reasoning_content: 'king' } }] }))
  assert.equal(aggregate.reasoning, 'thinking')
  assert.equal(aggregate.hadReasoning, true)
})

test('id, model, and usage are lifted off the stream', () => {
  const aggregate = emptyAggregate('requested-model')
  foldChatChunk(
    aggregate,
    chunk({
      id: 'gen-123',
      created: 42,
      model: 'served-model',
      choices: [{ delta: { content: 'x' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  )
  assert.equal(aggregate.id, 'gen-123')
  assert.equal(aggregate.created, 42)
  assert.equal(aggregate.model, 'served-model')
  assert.deepEqual(aggregate.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})

test('a finish_reason is recorded', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
  assert.equal(aggregate.finishReason, 'stop')
})

test('tool call fragments reassemble across chunks', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(
    aggregate,
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }],
          },
        },
      ],
    }),
  )
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] }))
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' "ls"}' } }] } }] }))
  assert.equal(aggregate.toolCalls.length, 1)
  assert.equal(aggregate.toolCalls[0]!.id, 'call_1')
  assert.equal(aggregate.toolCalls[0]!.function.name, 'bash')
  assert.equal(aggregate.toolCalls[0]!.function.arguments, '{"command": "ls"}')
})

test('parallel tool calls land in their own slots', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'read', arguments: '{}' } }] } }] }))
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'bash', arguments: '{}' } }] } }] }))
  assert.equal(aggregate.toolCalls.length, 2)
  assert.equal(aggregate.toolCalls[0]!.id, 'a')
  assert.equal(aggregate.toolCalls[1]!.id, 'b')
})

test('non-chunk payloads are ignored rather than fatal', () => {
  const aggregate = emptyAggregate('m')
  assert.equal(foldChatChunk(aggregate, 'not json'), false)
  assert.equal(foldChatChunk(aggregate, 'null'), false)
  assert.equal(foldChatChunk(aggregate, chunk({ choices: [] })), false)
})

test('an in-stream error object raises', () => {
  const aggregate = emptyAggregate('m')
  assert.throws(() => foldChatChunk(aggregate, chunk({ error: { message: 'upstream exploded' } })), /upstream exploded/)
})

test('a completion is assembled with usage and reasoning', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, chunk({ id: 'gen-1', model: 'mimo', choices: [{ delta: { reasoning: 'why', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))
  const completion = toChatCompletion(aggregate) as {
    object: string
    choices: Array<{ message: Record<string, unknown>; finish_reason: string }>
    usage: Record<string, unknown>
  }
  assert.equal(completion.object, 'chat.completion')
  assert.equal(completion.choices[0]!.message.content, 'hi')
  assert.equal(completion.choices[0]!.message.reasoning, 'why')
  assert.equal(completion.choices[0]!.message.reasoning_content, 'why')
  assert.equal(completion.choices[0]!.finish_reason, 'stop')
  assert.deepEqual(completion.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
})

test('tool calls produce null content and a tool_calls finish reason', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'bash', arguments: '{}' } }] } }] }))
  const completion = toChatCompletion(aggregate) as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }> }
  assert.equal(completion.choices[0]!.message.content, null)
  assert.equal(completion.choices[0]!.finish_reason, 'tool_calls')
  assert.ok(Array.isArray(completion.choices[0]!.message.tool_calls))
})

test('a length finish reason is preserved', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, chunk({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }))
  const completion = toChatCompletion(aggregate) as { choices: Array<{ finish_reason: string }> }
  assert.equal(completion.choices[0]!.finish_reason, 'length')
})

test('the reasoning alias is added to chunks by default', () => {
  const rewritten = rewriteChatChunk(chunk({ choices: [{ delta: { reasoning: 'thought' } }] }))
  const parsed = JSON.parse(rewritten) as { choices: Array<{ delta: Record<string, unknown> }> }
  assert.equal(parsed.choices[0]!.delta.reasoning, 'thought')
  assert.equal(parsed.choices[0]!.delta.reasoning_content, 'thought')
})

test('the reasoning alias can be suppressed instead', () => {
  const rewritten = rewriteChatChunk(chunk({ choices: [{ delta: { reasoning: 'thought', reasoning_details: [{}] } }] }), {
    reasoningAlias: false,
  })
  const parsed = JSON.parse(rewritten) as { choices: Array<{ delta: Record<string, unknown> }> }
  assert.equal(parsed.choices[0]!.delta.reasoning, undefined)
  assert.equal(parsed.choices[0]!.delta.reasoning_content, undefined)
})

test('chunks without reasoning are returned verbatim', () => {
  const original = chunk({ choices: [{ delta: { content: 'plain' } }] })
  assert.equal(rewriteChatChunk(original), original)
})

test('non-JSON chunk payloads pass through unchanged', () => {
  assert.equal(rewriteChatChunk('[DONE]'), '[DONE]')
})
