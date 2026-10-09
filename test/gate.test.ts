import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  apiForModel,
  ensureChatFreeLaneShape,
  ensureResponsesFreeLaneShape,
  FREE_LANE_GATE_TOOL_NAMES,
  isResponsesModel,
  reasoningEffortWire,
  toEffortIDs,
} from '../src/gate.ts'

const gateToolNames = (payload: unknown): string[] => {
  const tools = (payload as { tools?: Array<{ function?: { name?: string }; name?: string }> }).tools ?? []
  return tools.map((tool) => tool.function?.name ?? tool.name ?? '')
}

test('a chat body with no tools receives both gate tools and tool_choice none', () => {
  const shaped = ensureChatFreeLaneShape({ messages: [{ role: 'user', content: 'hi' }] }) as Record<string, unknown>
  assert.ok(shaped)
  for (const name of FREE_LANE_GATE_TOOL_NAMES) assert.ok(gateToolNames(shaped).includes(name))
  assert.equal(shaped.tool_choice, 'none')
})

test('a chat body already carrying the gate tools is left untouched', () => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'bash' } },
      { type: 'function', function: { name: 'read' } },
    ],
  }
  assert.equal(ensureChatFreeLaneShape(body), undefined)
})

test('a caller-provided tool_choice survives the gate rewrite', () => {
  const shaped = ensureChatFreeLaneShape({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'bash' } }],
    tool_choice: 'auto',
  }) as Record<string, unknown>
  assert.equal(shaped.tool_choice, 'auto')
  assert.deepEqual(gateToolNames(shaped).sort(), ['bash', 'read'])
})

test('only the missing gate tool is appended', () => {
  const shaped = ensureChatFreeLaneShape({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'bash' } }],
  }) as Record<string, unknown>
  assert.deepEqual(gateToolNames(shaped), ['bash', 'read'])
})

test('non-chat payloads are declined rather than rewritten', () => {
  assert.equal(ensureChatFreeLaneShape(null), undefined)
  assert.equal(ensureChatFreeLaneShape({ input: [] }), undefined)
  assert.equal(ensureChatFreeLaneShape('nope'), undefined)
})

test('a responses body receives flat gate tools and tool_choice auto', () => {
  const shaped = ensureResponsesFreeLaneShape({ input: [{ role: 'user', content: 'hi' }] }) as Record<string, unknown>
  assert.deepEqual(gateToolNames(shaped).sort(), ['bash', 'read'])
  assert.equal(shaped.tool_choice, 'auto')
})

test('a responses body with a non-auto tool_choice is corrected', () => {
  const shaped = ensureResponsesFreeLaneShape({
    input: [],
    tools: [
      { type: 'function', name: 'bash' },
      { type: 'function', name: 'read' },
    ],
    tool_choice: 'required',
  }) as Record<string, unknown>
  assert.equal(shaped.tool_choice, 'auto')
})

test('responses routing follows the muse-spark prefix', () => {
  assert.ok(isResponsesModel('muse-spark-1.3-contributor-free'))
  assert.ok(!isResponsesModel('mimo-v2.6-flash-free'))
  assert.ok(!isResponsesModel('gpt-5.3-codex-spark'))
  assert.equal(apiForModel('muse-spark-1.2-contributor-free'), 'openai-responses')
  assert.equal(apiForModel('mimo-v2.6-flash-free'), 'openai-completions')
})

test('reasoning effort maps off to the wire spelling none', () => {
  // Omission would leave an always-think model thinking, so off must be sent.
  assert.equal(reasoningEffortWire('off'), 'none')
  assert.equal(reasoningEffortWire('high'), 'high')
  assert.equal(reasoningEffortWire('max'), 'max')
  assert.equal(reasoningEffortWire(undefined), undefined)
  // An id the gateway does not accept injects nothing rather than risking a 400.
  assert.equal(reasoningEffortWire('bogus'), undefined)
})

test('effort ids decode from models.dev values with none folded to off', () => {
  assert.deepEqual(toEffortIDs(['low', 'high']), ['low', 'high'])
  assert.deepEqual(toEffortIDs(['none', 'high']), ['off', 'high'])
  // Ordered by the ladder, not by arrival.
  assert.deepEqual(toEffortIDs(['high', 'low', 'minimal']), ['minimal', 'low', 'high'])
  assert.deepEqual(toEffortIDs(undefined), [])
  assert.deepEqual(toEffortIDs(['unknown-value']), [])
})
