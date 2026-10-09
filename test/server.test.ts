import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { AddressInfo } from 'node:net'

import { ModelCatalog } from '../src/catalog.ts'
import { resolveConfig } from '../src/config.ts'
import { createApp } from '../src/server.ts'
import { ZenUpstream } from '../src/upstream.ts'

/**
 * End-to-end tests against the real HTTP surface with a stubbed upstream, so
 * routing, auth, request shaping, aggregation, and translation are all covered
 * without touching the network.
 */

/** A stub upstream that streams a canned chat completion. */
function chatUpstream(options: { calls?: Array<Record<string, unknown>>; fail?: Response } = {}): typeof fetch {
  return async (_input, init) => {
    if (options.fail) return options.fail
    if (init?.body) options.calls?.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    const frames = [
      { id: 'gen-1', created: 1, model: 'mimo-v2.6-flash-free', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] },
      { id: 'gen-1', created: 1, model: 'mimo-v2.6-flash-free', choices: [{ index: 0, delta: { content: ' there' } }] },
      { id: 'gen-1', created: 1, model: 'mimo-v2.6-flash-free', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } },
    ]
    const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

async function startServer(options: { config?: Record<string, unknown>; fetchImpl?: typeof fetch; catalogFetch?: typeof fetch } = {}) {
  const config = resolveConfig({ port: 0, ...options.config })
  const calls: Array<Record<string, unknown>> = []
  const catalog = new ModelCatalog({
    fetchImpl:
      options.catalogFetch ??
      (async (input) => {
        const url = String(input)
        if (url.includes('/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'claude-opus-5' }] }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            opencode: {
              models: {
                'mimo-v2.6-flash-free': { id: 'mimo-v2.6-flash-free', cost: { input: 0, output: 0 }, limit: { context: 200000, output: 16000 } },
                'claude-opus-5': { id: 'claude-opus-5', cost: { input: 3, output: 15 } },
              },
            },
          }),
          { status: 200 },
        )
      }),
  })
  await catalog.refreshOnce()
  const upstream = new ZenUpstream({ fetchImpl: options.fetchImpl ?? chatUpstream({ calls }), firstEventMs: 2000, bodyIdleMs: 2000 })
  const app = createApp({ config, catalog, upstream, log: () => {} })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()))
  const port = (app.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => app.close(() => resolve())),
  }
}

test('GET /healthz reports readiness and the exposed roster', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/healthz`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { ready: boolean; models: { exposed: number } }
    assert.equal(body.ready, true)
    assert.equal(body.models.exposed, 1)
  } finally {
    await server.close()
  }
})

test('GET /v1/models lists only the free models, with declared limits', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/models`)
    const body = (await response.json()) as { object: string; data: Array<{ id: string; context_window: number }> }
    assert.equal(body.object, 'list')
    assert.deepEqual(body.data.map((model) => model.id), ['mimo-v2.6-flash-free'])
    assert.equal(body.data[0]!.context_window, 200000)
  } finally {
    await server.close()
  }
})

test('a non-streaming completion is aggregated into one chat.completion', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { object: string; choices: Array<{ message: { content: string }; finish_reason: string }>; usage: Record<string, number> }
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices[0]!.message.content, 'Hello there')
    assert.equal(body.choices[0]!.finish_reason, 'stop')
    assert.equal(body.usage.total_tokens, 9)
  } finally {
    await server.close()
  }
})

test('the outgoing request always streams and carries the gate tools', async () => {
  const server = await startServer()
  try {
    await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const sent = server.calls[0]!
    assert.equal(sent.stream, true)
    const tools = sent.tools as Array<{ function: { name: string } }>
    assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ['bash', 'read'])
  } finally {
    await server.close()
  }
})

test('a streaming request relays an SSE stream ending in DONE', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const text = await response.text()
    assert.match(text, /data: \[DONE\]/)
    assert.match(text, /Hello/)
  } finally {
    await server.close()
  }
})

test('a paid model is refused before reaching upstream', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 404)
    assert.equal(server.calls.length, 0)
  } finally {
    await server.close()
  }
})

test('a missing messages array is a 400', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free' }),
    })
    assert.equal(response.status, 400)
  } finally {
    await server.close()
  }
})

test('malformed JSON is a 400, not a crash', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    })
    assert.equal(response.status, 400)
  } finally {
    await server.close()
  }
})

test('an unknown path is a 404', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/nonsense`)
    assert.equal(response.status, 404)
  } finally {
    await server.close()
  }
})

test('authentication is enforced on the API and not on healthz', async () => {
  const server = await startServer({ config: { apiKey: 'secret-token' } })
  try {
    assert.equal((await fetch(`${server.base}/healthz`)).status, 200)
    assert.equal((await fetch(`${server.base}/v1/models`)).status, 401)
    assert.equal((await fetch(`${server.base}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
    assert.equal((await fetch(`${server.base}/v1/models`, { headers: { authorization: 'Bearer secret-token' } })).status, 200)
  } finally {
    await server.close()
  }
})

test('a translated responses request reaches upstream as chat completions', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', input: 'hello', instructions: 'be terse' }),
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { object: string; output_text: string; output: Array<{ type: string }> }
    assert.equal(body.object, 'response')
    assert.equal(body.output_text, 'Hello there')
    assert.ok(body.output.some((item) => item.type === 'message'))
    // The chat model must NOT be sent to the upstream responses endpoint.
    const sent = server.calls[0]!
    assert.deepEqual(sent.messages, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ])
  } finally {
    await server.close()
  }
})

test('a streaming translated responses request emits responses events', async () => {
  const server = await startServer()
  try {
    const response = await fetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', input: 'hello', stream: true }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /event: response\.created/)
    assert.match(text, /event: response\.output_text\.delta/)
    assert.match(text, /event: response\.completed/)
  } finally {
    await server.close()
  }
})

test('an upstream HTTP failure surfaces as an error payload', async () => {
  const server = await startServer({
    fetchImpl: async () => new Response(JSON.stringify({ error: { type: 'FreeTierError', message: 'free tier' } }), { status: 403 }),
  })
  try {
    const response = await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 403)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /free lane refused/i)
  } finally {
    await server.close()
  }
})

test('the api key is not required when none is configured', async () => {
  const server = await startServer()
  try {
    assert.equal((await fetch(`${server.base}/v1/models`)).status, 200)
  } finally {
    await server.close()
  }
})

test('exposeAllModels lists the whole live roster', async () => {
  const server = await startServer({ config: { exposeAllModels: true } })
  try {
    const body = (await (await fetch(`${server.base}/v1/models`)).json()) as { data: Array<{ id: string; free?: boolean }> }
    assert.deepEqual(body.data.map((model) => model.id).sort(), ['claude-opus-5', 'mimo-v2.6-flash-free'])
    const paid = body.data.find((model) => model.id === 'claude-opus-5')
    assert.equal(paid?.free, false)
  } finally {
    await server.close()
  }
})

test('GET /v1/models/<id> returns one model and 404s an unknown id', async () => {
  const server = await startServer()
  try {
    const ok = await fetch(`${server.base}/v1/models/mimo-v2.6-flash-free`)
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { id: string }).id, 'mimo-v2.6-flash-free')
    assert.equal((await fetch(`${server.base}/v1/models/nope`)).status, 404)
  } finally {
    await server.close()
  }
})

test('a method mismatch is a 405', async () => {
  const server = await startServer()
  try {
    assert.equal((await fetch(`${server.base}/v1/chat/completions`)).status, 405)
    assert.equal((await fetch(`${server.base}/v1/models`, { method: 'POST' })).status, 405)
  } finally {
    await server.close()
  }
})
