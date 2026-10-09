import { strict as assert } from 'node:assert'
import test from 'node:test'

import { chatToResponsesObject, ChatToResponses, needsUpstreamResponses, responsesToChat } from '../src/responses.ts'
import { emptyAggregate, foldChatChunk } from '../src/openai.ts'

test('muse-spark models must use the upstream responses endpoint', () => {
  assert.equal(needsUpstreamResponses('muse-spark-1.3-contributor-free'), true)
  // Chat models reject the responses endpoint, so they must be translated.
  assert.equal(needsUpstreamResponses('mimo-v2.6-flash-free'), false)
})

test('a string input becomes one user message', () => {
  const chat = responsesToChat({ model: 'm', input: 'hello' })
  assert.deepEqual(chat.messages, [{ role: 'user', content: 'hello' }])
})

test('instructions become the system message', () => {
  const chat = responsesToChat({ input: 'hi', instructions: 'be terse' })
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
  ])
})

test('input_text parts are flattened', () => {
  const chat = responsesToChat({
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'part one' }, { type: 'input_text', text: ' two' }] }],
  })
  assert.deepEqual(chat.messages, [{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: ' two' }] }])
})

test('a function call and its output round-trip into chat messages', () => {
  const chat = responsesToChat({
    input: [
      { role: 'user', content: 'list files' },
      { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
    ],
  })
  const messages = chat.messages as Array<Record<string, unknown>>
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[1]!.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
  ])
  assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' })
})

test('flat responses tools become nested chat tools', () => {
  const chat = responsesToChat({
    input: 'hi',
    tools: [{ type: 'function', name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }],
  })
  assert.deepEqual(chat.tools, [
    { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } } },
  ])
})

test('an already-nested tool definition is accepted too', () => {
  const chat = responsesToChat({
    input: 'hi',
    tools: [{ type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object' } } }],
  })
  const tools = chat.tools as Array<{ function: { name: string } }>
  assert.equal(tools[0]!.function.name, 'read')
})

test('max_output_tokens maps onto the chat token cap', () => {
  const chat = responsesToChat({ input: 'hi', max_output_tokens: 512 })
  assert.equal(chat.max_tokens, 512)
})

test('a responses reasoning effort maps to the chat field with none folded to off', () => {
  assert.equal(responsesToChat({ input: 'hi', reasoning: { effort: 'high' } }).reasoning_effort, 'high')
  assert.equal(responsesToChat({ input: 'hi', reasoning: { effort: 'none' } }).reasoning_effort, 'off')
})

test('a stream flag is carried through', () => {
  assert.equal(responsesToChat({ input: 'hi', stream: true }).stream, true)
  assert.equal(responsesToChat({ input: 'hi' }).stream, undefined)
})

test('a non-streaming translated response renders a responses object', () => {
  const aggregate = emptyAggregate('mimo')
  foldChatChunk(aggregate, JSON.stringify({ id: 'gen-9', model: 'mimo', choices: [{ delta: { reasoning: 'why', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }))
  const response = chatToResponsesObject(aggregate) as {
    object: string
    status: string
    output_text: string
    output: Array<Record<string, unknown>>
    usage: Record<string, unknown>
  }
  assert.equal(response.object, 'response')
  assert.equal(response.status, 'completed')
  assert.equal(response.output_text, 'hi')
  assert.equal(response.output[0]!.type, 'reasoning')
  assert.equal(response.output[1]!.type, 'message')
  assert.equal(response.usage.input_tokens, 3)
})

test('a translated tool call renders as a function_call item', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'tool_calls' }] }))
  const response = chatToResponsesObject(aggregate) as { output: Array<Record<string, unknown>> }
  const call = response.output.find((item) => item.type === 'function_call')
  assert.ok(call)
  assert.equal(call.name, 'bash')
  assert.equal(call.arguments, '{"command":"ls"}')
  assert.equal(call.call_id, 'call_9')
})

test('a length finish reason renders an incomplete response', () => {
  const aggregate = emptyAggregate('m')
  foldChatChunk(aggregate, JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }))
  const response = chatToResponsesObject(aggregate) as { status: string; incomplete_details?: { reason: string } }
  assert.equal(response.status, 'incomplete')
  assert.equal(response.incomplete_details?.reason, 'max_output_tokens')
})

test('the streaming renderer emits the responses event sequence', () => {
  const aggregate = emptyAggregate('m')
  const renderer = new ChatToResponses(aggregate)
  const frames: string[] = []
  frames.push(...renderer.push(JSON.stringify({ id: 'gen-1', model: 'mimo', choices: [{ delta: { content: 'Hi' } }] })))
  frames.push(...renderer.finish())
  const types = frames.map((frame) => /^event: (.+)$/m.exec(frame)?.[1])
  assert.ok(types.includes('response.created'))
  assert.ok(types.includes('response.output_item.added'))
  assert.ok(types.includes('response.content_part.added'))
  assert.ok(types.includes('response.output_text.delta'))
  assert.ok(types.includes('response.output_item.done'))
  // The terminal event is what a client waits for.
  assert.equal(types.at(-1), 'response.completed')
})

test('the renderer reports failure without a completed event', () => {
  const renderer = new ChatToResponses(emptyAggregate('m'))
  const events = renderer.fail('upstream went silent')
  const types = events.map((frame) => /^event: (.+)$/m.exec(frame)?.[1])
  assert.deepEqual(types, ['response.failed'])
  assert.match(events[0]!, /upstream went silent/)
})

test('the renderer will not emit terminal events twice', () => {
  const renderer = new ChatToResponses(emptyAggregate('m'))
  renderer.push(JSON.stringify({ choices: [{ delta: { content: 'x' } }] }))
  const first = renderer.finish()
  assert.ok(first.length > 0)
  assert.deepEqual(renderer.finish(), [])
  assert.deepEqual(renderer.fail('too late'), [])
})

test('an empty stream still produces a terminal event', () => {
  const renderer = new ChatToResponses(emptyAggregate('m'))
  const types = renderer.finish().map((frame) => /^event: (.+)$/m.exec(frame)?.[1])
  assert.equal(types.at(-1), 'response.completed')
})

test('reasoning is surfaced as summary deltas', () => {
  const aggregate = emptyAggregate('m')
  const renderer = new ChatToResponses(aggregate)
  const frames = renderer.push(JSON.stringify({ choices: [{ delta: { reasoning: 'thinking' } }] }))
  const types = frames.map((frame) => /^event: (.+)$/m.exec(frame)?.[1])
  assert.ok(types.includes('response.reasoning_summary_text.delta'))
})

test('reasoning can be suppressed in the rendered events', () => {
  const renderer = new ChatToResponses(emptyAggregate('m'), { includeReasoning: false })
  const frames = renderer.push(JSON.stringify({ choices: [{ delta: { reasoning: 'secret', content: 'answer' } }] }))
  assert.ok(!frames.some((frame) => frame.includes('reasoning_summary_text')))
  assert.ok(frames.some((frame) => frame.includes('output_text.delta')))
})
