import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dayKey, hourKey, RecentRequests, StatsStore } from '../src/stats.ts'

function fixedClock(iso: string): () => number {
  return () => new Date(iso).getTime()
}

const record = (over: Partial<Parameters<StatsStore['record']>[0]> = {}) => ({
  model: 'mimo-v2.6-flash-free',
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  durationMs: 1000,
  failed: false,
  ...over,
})

test('dayKey and hourKey use local time', () => {
  const time = new Date(2026, 9, 8, 14, 30, 0)
  assert.equal(dayKey(time), '2026-10-08')
  assert.equal(hourKey(time), '2026-10-08T14')
})

test('a recorded request lands in the lifetime totals and the day bucket', () => {
  const stats = new StatsStore({ now: fixedClock('2026-10-08T12:00:00Z') })
  stats.record(record())
  const lifetime = stats.lifetime()
  assert.equal(lifetime.requests, 1)
  assert.equal(lifetime.total_tokens, 15)
  assert.equal(lifetime.prompt_tokens, 10)
  assert.equal(lifetime.completion_tokens, 5)
  assert.ok(lifetime.since)

  const snapshot = stats.snapshot('today')
  assert.equal(snapshot.totals.requests, 1)
  assert.equal(snapshot.totals.total_tokens, 15)
})

test('recorded numbers accumulate across requests', () => {
  const stats = new StatsStore()
  stats.record(record())
  stats.record(record({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }))
  assert.equal(stats.lifetime().requests, 2)
  assert.equal(stats.lifetime().total_tokens, 45)
})

test('a failed request is counted in both the total and the failure count', () => {
  const stats = new StatsStore()
  stats.record(record({ failed: true }))
  const lifetime = stats.lifetime()
  assert.equal(lifetime.requests, 1)
  assert.equal(lifetime.failed, 1)
})

test('the average rate divides completion tokens by elapsed seconds', () => {
  const stats = new StatsStore()
  // 100 completion tokens in 2000ms = 50 tok/s.
  stats.record(record({ completion_tokens: 100, durationMs: 2000 }))
  assert.equal(stats.snapshot('today').totals.avg_rate, 50)
})

test('the today range is bucketed by hour and always spans 24 slots', () => {
  const stats = new StatsStore({ now: fixedClock('2026-10-08T12:00:00Z') })
  stats.record(record())
  const snapshot = stats.snapshot('today')
  assert.equal(snapshot.unit, 'hour')
  assert.equal(snapshot.points.length, 24)
  // The bucket carrying the record is not necessarily index 12 outside UTC; the
  // sum is the invariant that matters.
  assert.equal(snapshot.points.reduce((sum, p) => sum + p.requests, 0), 1)
})

test('the 7d range spans exactly 7 calendar days including today', () => {
  const stats = new StatsStore({ now: fixedClock('2026-10-08T12:00:00Z') })
  const snapshot = stats.snapshot('7d')
  assert.equal(snapshot.unit, 'day')
  assert.equal(snapshot.points.length, 7)
  assert.equal(snapshot.points.at(-1)!.key, dayKey(new Date('2026-10-08T12:00:00Z')))
})

test('the 30d range spans exactly 30 days', () => {
  const stats = new StatsStore({ now: fixedClock('2026-10-08T12:00:00Z') })
  assert.equal(stats.snapshot('30d').points.length, 30)
})

test('empty days inside a range are present as zeros, not gaps', () => {
  const stats = new StatsStore({ now: fixedClock('2026-10-08T12:00:00Z') })
  stats.record(record())
  const snapshot = stats.snapshot('7d')
  // Every day is present so the chart reads gaps as "nothing happened".
  assert.equal(snapshot.points.filter((p) => p.requests === 0).length, 6)
})

test('the all range starts at the earliest recorded day', () => {
  let now = new Date('2026-10-01T10:00:00Z').getTime()
  const stats = new StatsStore({ now: () => now })
  stats.record(record())
  now = new Date('2026-10-08T10:00:00Z').getTime()
  stats.record(record())
  const snapshot = stats.snapshot('all')
  assert.equal(snapshot.from, dayKey(new Date('2026-10-01T10:00:00Z')))
  assert.equal(snapshot.points.length, 8)
})

test('per-model rollups aggregate and sort by size', () => {
  const stats = new StatsStore()
  stats.record(record({ model: 'a', total_tokens: 10 }))
  stats.record(record({ model: 'b', total_tokens: 30 }))
  stats.record(record({ model: 'a', total_tokens: 5 }))
  const models = stats.snapshot('today').models
  assert.deepEqual(models.map((m) => m.model), ['b', 'a'])
  assert.equal(models[1]!.total_tokens, 15)
  assert.equal(models[1]!.requests, 2)
})

test('model rollups respect the range window', () => {
  let now = new Date('2026-10-01T10:00:00Z').getTime()
  const stats = new StatsStore({ now: () => now })
  stats.record(record({ model: 'old' }))
  now = new Date('2026-10-08T10:00:00Z').getTime()
  stats.record(record({ model: 'new' }))
  assert.deepEqual(stats.snapshot('7d').models.map((m) => m.model), ['new'])
  assert.deepEqual(stats.snapshot('30d').models.map((m) => m.model).sort(), ['new', 'old'])
})

test('lifetime totals survive the retention window while detail is pruned', async () => {
  let now = new Date('2026-01-01T10:00:00Z').getTime()
  const stats = new StatsStore({ now: () => now, keepDays: 3 })
  stats.record(record({ total_tokens: 100 }))
  // Jump well past the retention window.
  now = new Date('2026-03-01T10:00:00Z').getTime()
  stats.record(record({ total_tokens: 7 }))

  assert.equal(stats.lifetime().total_tokens, 107)
  assert.equal(stats.lifetime().requests, 2)
  // The old day's detail is gone.
  const snapshot = stats.snapshot('30d')
  assert.equal(snapshot.totals.total_tokens, 7)
})

test('state persists and reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-stats-'))
  const path = join(dir, 'stats.json')
  try {
    const first = new StatsStore({ path, now: fixedClock('2026-10-08T12:00:00Z'), flushDelayMs: 1 })
    first.record(record({ total_tokens: 42, model: 'persisted' }))
    await first.flush()

    const second = new StatsStore({ path, now: fixedClock('2026-10-08T13:00:00Z') })
    await second.load()
    assert.equal(second.lifetime().total_tokens, 42)
    assert.equal(second.snapshot('today').models[0]!.model, 'persisted')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt state file is ignored rather than fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-stats-'))
  const path = join(dir, 'stats.json')
  try {
    await import('node:fs/promises').then((fs) => fs.writeFile(path, '{ not json', 'utf8'))
    const stats = new StatsStore({ path })
    await stats.load()
    assert.equal(stats.lifetime().requests, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent flushes do not corrupt the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-stats-'))
  const path = join(dir, 'stats.json')
  try {
    const stats = new StatsStore({ path, flushDelayMs: 1 })
    for (let i = 0; i < 50; i++) stats.record(record())
    await Promise.all([stats.flush(), stats.flush(), stats.flush()])
    const raw = JSON.parse(await readFile(path, 'utf8')) as { lifetime: { requests: number } }
    assert.equal(raw.lifetime.requests, 50)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('close flushes pending writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-stats-'))
  const path = join(dir, 'stats.json')
  try {
    const stats = new StatsStore({ path, flushDelayMs: 60_000 })
    stats.record(record())
    await stats.close()
    const raw = JSON.parse(await readFile(path, 'utf8')) as { lifetime: { requests: number } }
    assert.equal(raw.lifetime.requests, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('summary reports the retention window and the earliest day', () => {
  const stats = new StatsStore({ now: fixedClock('2026-10-08T12:00:00Z'), keepDays: 14 })
  stats.record(record())
  const summary = stats.summary()
  assert.equal(summary.keepDays, 14)
  assert.equal(summary.earliest, dayKey(new Date('2026-10-08T12:00:00Z')))
})

test('the recent-request ring is newest-first and bounded', () => {
  const recent = new RecentRequests(3)
  for (let i = 0; i < 5; i++) {
    recent.push({ model: 'm' + i, status: 200, streaming: false, prompt_tokens: 1, completion_tokens: 1, duration_ms: 10 })
  }
  const list = recent.list()
  assert.equal(list.length, 3)
  assert.deepEqual(list.map((r) => r.model), ['m4', 'm3', 'm2'])
})

test('clearing the recent ring leaves its sequence counter monotonic', () => {
  const recent = new RecentRequests(5)
  recent.push({ model: 'a', status: 200, streaming: false, prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 })
  const before = recent.list()[0]!.seq
  recent.clear()
  recent.push({ model: 'b', status: 200, streaming: false, prompt_tokens: 0, completion_tokens: 0, duration_ms: 0 })
  assert.ok(recent.list()[0]!.seq > before)
})
