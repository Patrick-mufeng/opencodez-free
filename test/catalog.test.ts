import { strict as assert } from 'node:assert'
import test from 'node:test'

import { decide, decodeModelsDev, ModelCatalog, isFreeModel, type ModelPrice } from '../src/catalog.ts'

function prices(entries: Record<string, Partial<ModelPrice>>): Map<string, ModelPrice> {
  const map = new Map<string, ModelPrice>()
  for (const [id, value] of Object.entries(entries)) {
    map.set(id, { deprecated: false, ...value })
  }
  return map
}

test('isFreeModel matches the upstream naming convention', () => {
  assert.ok(isFreeModel('mimo-v2.6-flash-free'))
  assert.ok(isFreeModel('MIMO-FREE'))
  assert.ok(!isFreeModel('claude-opus-5'))
})

test('zero-cost metadata allows the model', () => {
  const decision = decide('mimo-v2.6-flash-free', prices({ 'mimo-v2.6-flash-free': { input: 0, output: 0 } }), true)
  assert.equal(decision.allowed, true)
  assert.equal(decision.source, 'name_and_metadata_free')
})

test('paid metadata denies even a model named free', () => {
  // The name fallback must never override a negative metadata verdict.
  const decision = decide('sneaky-free', prices({ 'sneaky-free': { input: 3, output: 15 } }), true)
  assert.equal(decision.allowed, false)
  assert.equal(decision.source, 'metadata_paid')
  assert.equal(decision.known, true)
})

test('a deprecated model is denied when the name says free', () => {
  const decision = decide('old-free', prices({ 'old-free': { input: 0, output: 0, deprecated: true } }), true)
  assert.equal(decision.allowed, false)
  assert.equal(decision.source, 'metadata_deprecated')
})

test('a free name is allowed while metadata is still pending', () => {
  const decision = decide('anything-free', new Map(), false)
  assert.equal(decision.allowed, true)
  assert.equal(decision.source, 'name_free')
  assert.equal(decision.known, false)
})

test('an unknown non-free model is denied', () => {
  const decision = decide('mystery-model', prices({ x: { input: 0, output: 0 } }), true)
  assert.equal(decision.allowed, false)
  assert.equal(decision.source, 'metadata_model_missing')
})

test('decodeModelsDev reads the opencode provider section', () => {
  const decoded = decodeModelsDev({
    openai: { models: { 'gpt-x': { id: 'gpt-x', cost: { input: 1, output: 2 } } } },
    opencode: {
      models: {
        'mimo-v2.6-flash-free': {
          id: 'mimo-v2.6-flash-free',
          cost: { input: 0, output: 0 },
          limit: { context: 262144, output: 32768 },
          modalities: { input: ['text', 'image'] },
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        },
      },
    },
  })
  const model = decoded.get('mimo-v2.6-flash-free')
  assert.ok(model)
  assert.equal(model.input, 0)
  assert.equal(model.contextWindow, 262144)
  assert.equal(model.maxOutput, 32768)
  assert.deepEqual(model.modalities, ['text', 'image'])
  assert.equal(model.reasoning, true)
  assert.deepEqual(model.effortValues, ['low', 'high'])
})

test('decodeModelsDev prefers the exact opencode key over a partial match', () => {
  const decoded = decodeModelsDev({
    'opencode-fork': { id: 'forked', models: { shared: { id: 'shared', cost: { input: 9, output: 9 } } } },
    opencode: { models: { shared: { id: 'shared', cost: { input: 0, output: 0 } } } },
  })
  assert.equal(decoded.get('shared')?.input, 0)
})

test('decodeModelsDev reads the nested deprecated and status markers', () => {
  const decoded = decodeModelsDev({
    opencode: {
      models: {
        a: { id: 'a', status: 'deprecated' },
        b: { id: 'b', deprecated_at: '2026-01-01' },
        c: { id: 'c' },
      },
    },
  })
  assert.equal(decoded.get('a')?.deprecated, true)
  assert.equal(decoded.get('b')?.deprecated, true)
  assert.equal(decoded.get('c')?.deprecated, false)
})

test('decodeModelsDev tolerates a malformed payload', () => {
  assert.equal(decodeModelsDev(null).size, 0)
  assert.equal(decodeModelsDev({}).size, 0)
  assert.equal(decodeModelsDev({ opencode: {} }).size, 0)
})

test('a catalog with no live roster serves the bootstrap list', () => {
  const catalog = new ModelCatalog()
  const list = catalog.list()
  assert.ok(list.length > 0)
  assert.equal(catalog.snapshot().status, 'pending')
})

test('the static list stays vouched when metadata claims deprecation', () => {
  // Verified against the live lane, so a stale metadata verdict must not hide it.
  const catalog = new ModelCatalog()
  const decision = catalog.decision('mimo-v2.6-flash-free')
  assert.equal(decision.allowed, true)
})

test('the catalog does not gate on expose-all; the caller owns that switch', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'claude-opus-5' }] }), { status: 200 })
    }
    return new Response(
      JSON.stringify({
        opencode: {
          models: {
            'mimo-v2.6-flash-free': { id: 'mimo-v2.6-flash-free', cost: { input: 0, output: 0 } },
            'claude-opus-5': { id: 'claude-opus-5', cost: { input: 3, output: 15 } },
          },
        },
      }),
      { status: 200 },
    )
  }
  const catalog = new ModelCatalog({ fetchImpl, refreshSeconds: 3600 })
  await catalog.refreshOnce()
  // list() stays free-only; allModels() exposes the raw roster for the caller.
  assert.deepEqual(catalog.list(), ['mimo-v2.6-flash-free'])
  assert.deepEqual(catalog.allModels(), ['claude-opus-5', 'mimo-v2.6-flash-free'])
  assert.equal(catalog.decision('claude-opus-5').allowed, false)
})

test('a catalog refresh populates the roster from a stubbed upstream', async () => {
  const seen: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'claude-opus-5' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({
        opencode: {
          models: {
            'mimo-v2.6-flash-free': { id: 'mimo-v2.6-flash-free', cost: { input: 0, output: 0 } },
            'claude-opus-5': { id: 'claude-opus-5', cost: { input: 3, output: 15 } },
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const catalog = new ModelCatalog({ fetchImpl, refreshSeconds: 3600 })
  await catalog.refreshOnce()
  assert.equal(catalog.liveCount, 2)
  // Only the free model is exposed.
  assert.deepEqual(catalog.list(), ['mimo-v2.6-flash-free'])
  assert.equal(catalog.snapshot().status, 'ready')
  assert.ok(seen.some((url) => url.includes('/v1/models')))
})

test('an upstream failure surfaces as a recorded error without throwing', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error('network down')
  }
  const catalog = new ModelCatalog({ fetchImpl, cachePath: undefined })
  await catalog.refreshOnce()
  assert.equal(catalog.liveCount, 0)
  assert.match(catalog.lastError, /network down/)
  // The bootstrap list still backs the roster.
  assert.ok(catalog.list().length > 0)
})

test('declared limits and reasoning capability are exposed when known', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }] }), { status: 200 })
    }
    return new Response(
      JSON.stringify({
        opencode: {
          models: {
            'mimo-v2.6-flash-free': {
              id: 'mimo-v2.6-flash-free',
              cost: { input: 0, output: 0 },
              limit: { context: 100000, output: 8000 },
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            },
          },
        },
      }),
      { status: 200 },
    )
  }
  const catalog = new ModelCatalog({ fetchImpl, refreshSeconds: 3600 })
  await catalog.refreshOnce()
  assert.deepEqual(catalog.limits('mimo-v2.6-flash-free'), { contextWindow: 100000, maxOutput: 8000 })
  assert.deepEqual(catalog.reasoningCapability('mimo-v2.6-flash-free'), { reasoning: true, effortValues: ['low', 'high'] })
  // Unknown models report nothing so the caller keeps its defaults.
  assert.equal(catalog.limits('stranger'), undefined)
  assert.equal(catalog.reasoningCapability('stranger'), undefined)
})
