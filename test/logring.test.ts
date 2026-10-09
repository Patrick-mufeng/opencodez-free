import { strict as assert } from 'node:assert'
import test from 'node:test'

import { classifyChannel, LogRing } from '../src/logring.ts'

test('entries are returned oldest-first', () => {
  const ring = new LogRing(10)
  ring.push('info', 'first')
  ring.push('info', 'second')
  assert.deepEqual(ring.list().map((e) => e.message), ['first', 'second'])
})

test('the ring is bounded and drops the oldest entries', () => {
  const ring = new LogRing(3)
  for (let i = 0; i < 6; i++) ring.push('info', 'm' + i)
  assert.equal(ring.size, 3)
  assert.deepEqual(ring.list().map((e) => e.message), ['m3', 'm4', 'm5'])
})

test('debug entries are not recorded', () => {
  const ring = new LogRing(10)
  ring.push('debug', 'noise')
  ring.push('info', 'signal')
  assert.deepEqual(ring.list().map((e) => e.message), ['signal'])
})

test('error and warn entries are recorded', () => {
  const ring = new LogRing(10)
  ring.push('error', 'bad')
  ring.push('warn', 'hmm')
  assert.equal(ring.size, 2)
  assert.equal(ring.list()[0]!.level, 'error')
})

test('sequence numbers are monotonic so the panel can poll incrementally', () => {
  const ring = new LogRing(10)
  ring.push('info', 'a')
  ring.push('info', 'b')
  ring.push('info', 'c')
  const all = ring.list()
  assert.ok(all[0]!.seq < all[1]!.seq)
  assert.ok(all[1]!.seq < all[2]!.seq)
  assert.equal(ring.lastSeq, all[2]!.seq)
})

test('the since filter returns only newer entries', () => {
  const ring = new LogRing(10)
  ring.push('info', 'a')
  ring.push('info', 'b')
  const firstTwo = ring.list()
  ring.push('info', 'c')
  const incremental = ring.list({ since: firstTwo[1]!.seq })
  assert.deepEqual(incremental.map((e) => e.message), ['c'])
})

test('the channel filter narrows the result', () => {
  const ring = new LogRing(10)
  ring.push('info', 'a', { channel: 'chat' })
  ring.push('info', 'b', { channel: 'task' })
  ring.push('info', 'c', { channel: 'sys' })
  assert.deepEqual(ring.list({ channel: 'chat' }).map((e) => e.message), ['a'])
  assert.deepEqual(ring.list({ channel: 'task' }).map((e) => e.message), ['b'])
  assert.equal(ring.list({ channel: 'all' }).length, 3)
})

test('the limit keeps the newest entries', () => {
  const ring = new LogRing(10)
  for (let i = 0; i < 5; i++) ring.push('info', 'm' + i)
  assert.deepEqual(ring.list({ limit: 2 }).map((e) => e.message), ['m3', 'm4'])
})

test('extra fields travel with the entry', () => {
  const ring = new LogRing(10)
  ring.push('info', 'with data', { extra: { model: 'x', ms: 12 } })
  assert.deepEqual(ring.list()[0]!.extra, { model: 'x', ms: 12 })
})

test('an entry without extras omits the field entirely', () => {
  const ring = new LogRing(10)
  ring.push('info', 'plain')
  assert.equal(ring.list()[0]!.extra, undefined)
})

test('clear empties the ring but the sequence keeps advancing', () => {
  const ring = new LogRing(10)
  ring.push('info', 'a')
  const before = ring.lastSeq
  ring.clear()
  assert.equal(ring.size, 0)
  ring.push('info', 'b')
  assert.ok(ring.lastSeq > before)
})

test('channels are classified from the message and extras', () => {
  assert.equal(classifyChannel('POST /v1/chat/completions'), 'chat')
  assert.equal(classifyChannel('POST /v1/responses'), 'chat')
  assert.equal(classifyChannel('anything', { model: 'x' }), 'chat')
  assert.equal(classifyChannel('probe started for 3 model(s)'), 'task')
  assert.equal(classifyChannel('POST /panel/api/probe'), 'task')
  assert.equal(classifyChannel('server listening'), 'sys')
})
