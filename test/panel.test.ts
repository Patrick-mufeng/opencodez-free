import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

import { ModelCatalog } from '../src/catalog.ts'
import { resolveConfig } from '../src/config.ts'
import { LogRing } from '../src/logring.ts'
import { createLogger } from '../src/logger.ts'
import { createAssets, createPanel } from '../src/panel.ts'
import { ModelProbe } from '../src/probe.ts'
import { createApp } from '../src/server.ts'
import { RecentRequests, StatsStore } from '../src/stats.ts'
import { ZenUpstream } from '../src/upstream.ts'

/**
 * Panel API tests: run the real HTTP surface with a stubbed upstream, so
 * routing, auth, config round-tripping, and the probe endpoints are covered
 * without touching the network.
 */

const PANEL_HTML = '<!doctype html><title>panel</title>'
const PANEL_JS = '/* panel */'

async function harness(options: { config?: Record<string, unknown>; upstreamFetch?: typeof fetch; configPath?: string } = {}) {
  const config = resolveConfig({ port: 0, ...options.config })
  const calls: Array<Record<string, unknown>> = []
  const upstreamFetch: typeof fetch =
    options.upstreamFetch ??
    (async (_input, init) => {
      if (init?.body) calls.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(
        `data: ${JSON.stringify({ id: 'g', model: 'mimo-v2.6-flash-free', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`,
        { status: 200 },
      )
    })

  const catalog = new ModelCatalog({
    fetchImpl: async (input) => {
      const url = String(input)
      if (url.includes('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'claude-opus-5' }] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          opencode: {
            models: {
              'mimo-v2.6-flash-free': {
                id: 'mimo-v2.6-flash-free',
                cost: { input: 0, output: 0 },
                limit: { context: 1000, output: 100 },
                reasoning: true,
                reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
              },
              'claude-opus-5': { id: 'claude-opus-5', cost: { input: 3, output: 15 } },
            },
          },
        }),
        { status: 200 },
      )
    },
  })
  await catalog.refreshOnce()

  const upstream = new ZenUpstream({ fetchImpl: upstreamFetch, firstEventMs: 2000, bodyIdleMs: 2000 })
  const stats = new StatsStore()
  const recent = new RecentRequests(10)
  const logs = new LogRing(50)
  const probe = new ModelProbe(upstream, catalog, { concurrency: 2, timeoutMs: 5000 })
  const configPath = options.configPath ?? join(await mkdtemp(join(tmpdir(), 'o2f-panel-')), 'config.json')

  // `resolveConfig` carries agentKey, but the harness must also pin the panel
  // key onto the live object the way a real startup does — including leaving it
  // empty when panel auth is off, which is the default.
  let live: ServiceConfig = {
    ...config,
    panelKey: config.panelAuth ? config.apiKey : '',
    agentKey: config.auth ? (config.agentKey || config.apiKey) : '',
  }
  const panel = createPanel(
    {
      config: live,
      configPath,
      catalog,
      probe,
      stats,
      recent,
      logs,
      getConfig: () => live,
      onConfigChange: (next) => { live = next },
      // Mirror the real wiring: the keys survive a save because they live
      // outside the config file, and panel auth gates the panel credential.
      resolveKey: async (candidate) => candidate.apiKey || live.panelKey || '',
      authSource: config.panelAuth ? 'configured' : 'disabled',
      authKeyPath: join(dirname(configPath), 'api-key.txt'),
      agentKeyPath: join(dirname(configPath), 'agent-key.txt'),
      agentKeySource: config.auth ? 'configured' : 'disabled',
      log: () => {},
      startedAt: Date.now(),
      version: 'test',
    },
    { html: async () => PANEL_HTML, js: async () => PANEL_JS },
  )

  // The app reads through the same accessor the panel writes, so a save is
  // visible to request handling without a restart.
  const app = createApp({
    config: live,
    getConfig: () => live,
    catalog,
    upstream,
    log: () => {},
    panel,
    usage: { stats, recent },
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()))
  const port = (app.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    stats,
    recent,
    logs,
    probe,
    configPath,
    getLive: () => live,
    close: () => new Promise<void>((resolve) => app.close(() => resolve())),
  }
}

test('the panel page and script are served without a key', async () => {
  const server = await harness({ config: { apiKey: 'secret', panelAuth: true } })
  try {
    const page = await fetch(`${server.base}/panel/`)
    assert.equal(page.status, 200)
    assert.equal(await page.text(), PANEL_HTML)
    const js = await fetch(`${server.base}/panel/app.js`)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type') ?? '', /javascript/)
  } finally {
    await server.close()
  }
})

test('/panel (no trailing slash) serves the page too', async () => {
  const server = await harness()
  try {
    assert.equal((await fetch(`${server.base}/panel`)).status, 200)
  } finally {
    await server.close()
  }
})

test('panel APIs require the key when panel auth is on', async () => {
  const server = await harness({ config: { apiKey: 'secret', panelAuth: true } })
  try {
    assert.equal((await fetch(`${server.base}/panel/api/overview`)).status, 401)
    assert.equal((await fetch(`${server.base}/panel/api/overview`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
    assert.equal((await fetch(`${server.base}/panel/api/overview`, { headers: { authorization: 'Bearer secret' } })).status, 200)
  } finally {
    await server.close()
  }
})

test('the key may arrive as a query parameter for browser navigation', async () => {
  const server = await harness({ config: { apiKey: 'secret', panelAuth: true } })
  try {
    assert.equal((await fetch(`${server.base}/panel/api/overview?key=secret`)).status, 200)
  } finally {
    await server.close()
  }
})

test('the key may arrive as a cookie', async () => {
  const server = await harness({ config: { apiKey: 'secret', panelAuth: true } })
  try {
    const response = await fetch(`${server.base}/panel/api/overview`, { headers: { cookie: 'opencodez_key=secret' } })
    assert.equal(response.status, 200)
  } finally {
    await server.close()
  }
})

test('overview reports the service, catalog, usage, and recent requests', async () => {
  const server = await harness()
  try {
    await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = (await (await fetch(`${server.base}/panel/api/overview`)).json()) as {
      service: { base_url: string; auth: boolean; version: string }
      catalog: { exposed: number; live: number; status: string }
      usage: { requests: number; total_tokens: number }
      recent: Array<{ model: string; status: number }>
    }
    assert.match(body.service.base_url, /\/v1$/)
    assert.equal(body.service.auth, false)
    assert.equal(body.service.version, 'test')
    assert.equal(body.catalog.exposed, 1)
    assert.equal(body.catalog.live, 2)
    assert.equal(body.usage.requests, 1)
    assert.equal(body.usage.total_tokens, 7)
    assert.equal(body.recent.length, 1)
    assert.equal(body.recent[0]!.model, 'mimo-v2.6-flash-free')
  } finally {
    await server.close()
  }
})

test('stats serves a windowed time series with lifetime totals', async () => {
  const server = await harness()
  try {
    await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = (await (await fetch(`${server.base}/panel/api/stats?range=7d`)).json()) as {
      range: string
      unit: string
      points: unknown[]
      totals: { requests: number }
      models: Array<{ model: string }>
      summary: { lifetime: { requests: number } }
    }
    assert.equal(body.range, '7d')
    assert.equal(body.unit, 'day')
    assert.equal(body.points.length, 7)
    assert.equal(body.totals.requests, 1)
    assert.equal(body.summary.lifetime.requests, 1)
    assert.deepEqual(body.models.map((m) => m.model), ['mimo-v2.6-flash-free'])
  } finally {
    await server.close()
  }
})

test('an unknown stats range falls back to 30d', async () => {
  const server = await harness()
  try {
    const body = (await (await fetch(`${server.base}/panel/api/stats?range=bogus`)).json()) as { range: string }
    assert.equal(body.range, '30d')
  } finally {
    await server.close()
  }
})

test('the models endpoint exposes capabilities from metadata', async () => {
  const server = await harness()
  try {
    const body = (await (await fetch(`${server.base}/panel/api/models`)).json()) as {
      data: Array<{ id: string; context_window: number; max_output: number; reasoning: boolean; efforts: string[]; protocol: string; free: boolean }>
    }
    assert.equal(body.data.length, 1)
    const model = body.data[0]!
    assert.equal(model.id, 'mimo-v2.6-flash-free')
    assert.equal(model.context_window, 1000)
    assert.equal(model.max_output, 100)
    assert.equal(model.reasoning, true)
    assert.deepEqual(model.efforts, ['low', 'high'])
    assert.equal(model.protocol, 'completions')
    assert.equal(model.free, true)
  } finally {
    await server.close()
  }
})

test('a single-model probe runs and records its result', async () => {
  const server = await harness()
  try {
    const body = (await (
      await fetch(`${server.base}/panel/api/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.6-flash-free' }),
      })
    ).json()) as { result: { model: string; status: string; chars: number }; counts: { ok: number } }
    assert.equal(body.result.status, 'ok')
    assert.equal(body.result.chars, 2)
    assert.equal(body.counts.ok, 1)
  } finally {
    await server.close()
  }
})

test('a batch probe over the roster reports progress', async () => {
  const server = await harness()
  try {
    const start = (await (
      await fetch(`${server.base}/panel/api/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ concurrency: 1 }),
      })
    ).json()) as { running: boolean; queue: unknown[] }
    assert.equal(start.running, true)
    assert.equal(start.queue.length, 1)
    // Wait for the single-model queue to settle.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const after = (await (await fetch(`${server.base}/panel/api/probe`)).json()) as { running: boolean; progress: { done: number } }
    assert.equal(after.running, false)
    assert.equal(after.progress.done, 1)
  } finally {
    await server.close()
  }
})

test('a second batch is refused while one is running', async () => {
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  const server = await harness({
    upstreamFetch: async () => {
      await gate
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 })
    },
  })
  try {
    await fetch(`${server.base}/panel/api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ concurrency: 1 }),
    })
    const second = await fetch(`${server.base}/panel/api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ concurrency: 1 }),
    })
    assert.equal(second.status, 409)
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 300))
  } finally {
    await server.close()
  }
})

test('logs are served with channel filtering and incremental paging', async () => {
  const server = await harness()
  try {
    server.logs.push('info', 'chat happened', { channel: 'chat' })
    server.logs.push('info', 'task happened', { channel: 'task' })
    const all = (await (await fetch(`${server.base}/panel/api/logs`)).json()) as { entries: unknown[]; lastSeq: number }
    assert.equal(all.entries.length, 2)

    const chat = (await (await fetch(`${server.base}/panel/api/logs?channel=chat`)).json()) as { entries: Array<{ message: string }> }
    assert.equal(chat.entries.length, 1)
    assert.equal(chat.entries[0]!.message, 'chat happened')

    server.logs.push('info', 'another', { channel: 'chat' })
    const incremental = (await (await fetch(`${server.base}/panel/api/logs?since=${all.lastSeq}`)).json()) as { entries: unknown[] }
    assert.equal(incremental.entries.length, 1)
  } finally {
    await server.close()
  }
})

test('the logger classifies request logs into channels', async () => {
  // Classification lives in the logger (the ring stores what it is given), so
  // exercise that seam directly.
  const ring = new LogRing(20)
  const log = createLogger({ logLevel: 'silent' }, ring)
  log('info', 'POST /v1/chat/completions', { status: 200 })
  log('info', 'probe started for 3 model(s)', { channel: 'task' })
  log('info', 'server listening', {})
  const channels = ring.list().map((entry) => entry.channel)
  assert.deepEqual(channels, ['chat', 'task', 'sys'])
})

test('the log ring stays silent at the debug level', () => {
  const ring = new LogRing(20)
  const log = createLogger({ logLevel: 'silent' }, ring)
  // Debug is noise for the panel; it must not fill the ring.
  log('debug', 'upstream attempt', {})
  assert.equal(ring.size, 0)
})

test('config round-trips through the panel and takes effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const configPath = join(dir, 'config.json')
  const server = await harness({ configPath })
  try {
    const read = (await (await fetch(`${server.base}/panel/api/config`)).json()) as { config: Record<string, unknown>; path: string }
    assert.equal(read.path, configPath)
    assert.equal(read.config.port, 0)

    const save = await fetch(`${server.base}/panel/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshSeconds: 600, includeReasoning: false, exposeAllModels: true }),
    })
    assert.equal(save.status, 200)

    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    assert.equal(onDisk.refreshSeconds, 600)
    assert.equal(onDisk.includeReasoning, false)
    assert.equal(onDisk.exposeAllModels, true)

    // The live config the caller handed us was refreshed.
    const live = server.getLive()
    assert.equal(live.refreshSeconds, 600)
    assert.equal(live.includeReasoning, false)
    assert.equal(live.exposeAllModels, true)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the panel cannot write fields outside its own set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const configPath = join(dir, 'config.json')
  const server = await harness({ configPath })
  try {
    await fetch(`${server.base}/panel/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zenBaseUrl: 'http://evil.example', statsPath: '/tmp/evil.json', refreshSeconds: 120 }),
    })
    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    // Only the editable key landed; the two smuggled keys were dropped.
    assert.equal(onDisk.refreshSeconds, 120)
    assert.equal(onDisk.zenBaseUrl, undefined)
    assert.equal(onDisk.statsPath, undefined)
    assert.equal(server.getLive().zenBaseUrl, 'https://opencode.ai/zen')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the config read returns every key the form binds', async () => {
  // A form control without a matching editable key renders empty and cannot be
  // saved — this guards that class of drift between the HTML and the server.
  const server = await harness()
  try {
    const read = (await (await fetch(`${server.base}/panel/api/config`)).json()) as { config: Record<string, unknown> }
    for (const key of ['host', 'port', 'apiKey', 'defaultModel', 'refreshSeconds', 'exposeAllModels', 'includeReasoning',
      'firstEventMs', 'bodyIdleMs', 'responsesBodyIdleMs', 'maxRotates', 'maxBodyBytes', 'requestTimeoutMs',
      'panel', 'statsKeepDays', 'logLevel']) {
      assert.ok(key in read.config, `config response is missing the form field "${key}"`)
    }
  } finally {
    await server.close()
  }
})

test('a panel toggle round-trips as a real boolean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const configPath = join(dir, 'config.json')
  const server = await harness({ configPath })
  try {
    await fetch(`${server.base}/panel/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panel: false, statsKeepDays: 14 }),
    })
    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    assert.equal(onDisk.panel, false)
    assert.equal(onDisk.statsKeepDays, 14)
    assert.equal(server.getLive().panel, false)
    assert.equal(server.getLive().statsKeepDays, 14)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a saved config is reflected by the API and by request handling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const configPath = join(dir, 'config.json')
  const server = await harness({ configPath })
  try {
    // Confirm the starting state through the API the browser reads.
    const before = (await (await fetch(`${server.base}/panel/api/config`)).json()) as { config: { refreshSeconds: number } }
    assert.equal(before.config.refreshSeconds, 300)

    await fetch(`${server.base}/panel/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshSeconds: 420, defaultModel: 'mimo-v2.6-flash-free' }),
    })

    // Re-reading must show the new value, not a config captured at startup.
    const after = (await (await fetch(`${server.base}/panel/api/config`)).json()) as {
      config: { refreshSeconds: number; defaultModel: string }
    }
    assert.equal(after.config.refreshSeconds, 420)
    assert.equal(after.config.defaultModel, 'mimo-v2.6-flash-free')

    // Request handling sees it too: a request with no model now resolves to the
    // configured default rather than failing.
    const response = await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    assert.equal(server.calls.at(-1)?.model, 'mimo-v2.6-flash-free')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the overview reflects a saved config immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const configPath = join(dir, 'config.json')
  const server = await harness({ configPath })
  try {
    await fetch(`${server.base}/panel/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exposeAllModels: true }),
    })
    const body = (await (await fetch(`${server.base}/panel/api/overview`)).json()) as { catalog: { expose_all: boolean } }
    assert.equal(body.catalog.expose_all, true)
    // And the model list follows the new setting.
    const models = (await (await fetch(`${server.base}/panel/api/models`)).json()) as { data: Array<{ id: string }> }
    assert.equal(models.data.length, 2)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a panel save never writes the key into the config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const configPath = join(dir, 'config.json')
  const server = await harness({ configPath, config: { apiKey: 'secret-key', panelAuth: true } })
  try {
    const read = (await (await fetch(`${server.base}/panel/api/config`, {
      headers: { authorization: 'Bearer secret-key' },
    })).json()) as { config: Record<string, unknown> }
    // The form is shown a blank field plus a flag; echoing the real key would
    // invite a routine save to persist a secret into a shareable file.
    assert.equal(read.config.apiKey, '')
    assert.equal(read.config.hasApiKey, true)

    // The real form submits every field it owns, so panelAuth travels with the
    // save; the key field is the one left blank.
    await fetch(`${server.base}/panel/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-key' },
      body: JSON.stringify({ refreshSeconds: 500, panelAuth: true, apiKey: '' }),
    })
    const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    assert.equal(onDisk.apiKey, undefined)
    assert.equal(onDisk.agentKey, undefined)
    // And auth still works afterwards: a blank field means "keep the key".
    assert.equal(server.getLive().apiKey, 'secret-key')
    assert.equal((await fetch(`${server.base}/panel/api/overview`)).status, 401)
    assert.equal(
      (await fetch(`${server.base}/panel/api/overview`, { headers: { authorization: 'Bearer secret-key' } })).status,
      200,
    )
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the auth endpoint reports the key to an already-authenticated caller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const server = await harness({ configPath: join(dir, 'config.json'), config: { apiKey: 'secret-key', panelAuth: true } })
  try {
    assert.equal((await fetch(`${server.base}/panel/api/auth`)).status, 401)
    const body = (await (await fetch(`${server.base}/panel/api/auth`, {
      headers: { authorization: 'Bearer secret-key' },
    })).json()) as { enabled: boolean; key: string }
    assert.equal(body.enabled, true)
    assert.equal(body.key, 'secret-key')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('auth can be disabled from the panel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const server = await harness({ configPath: join(dir, 'config.json') })
  try {
    assert.equal((await fetch(`${server.base}/panel/api/overview`)).status, 200)
    await fetch(`${server.base}/panel/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: false }),
    })
    assert.equal(server.getLive().auth, false)
    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>
    assert.equal(onDisk.auth, false)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the agent key authenticates /v1 through every supported header', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const server = await harness({ configPath: join(dir, 'config.json'), config: { apiKey: 'panel-key', agentKey: 'agent-key', panelAuth: true } })
  try {
    const url = `${server.base}/v1/models`
    // OpenAI convention.
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer agent-key' } })).status, 200)
    // A gateway that dropped the scheme.
    assert.equal((await fetch(url, { headers: { authorization: 'agent-key' } })).status, 200)
    // Anthropic-style and Azure-style clients.
    assert.equal((await fetch(url, { headers: { 'x-api-key': 'agent-key' } })).status, 200)
    assert.equal((await fetch(url, { headers: { 'api-key': 'agent-key' } })).status, 200)
    // The panel key also works on /v1, so a single-key setup is unaffected.
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer panel-key' } })).status, 200)
    // Anything else is still refused.
    assert.equal((await fetch(url, { headers: { 'x-api-key': 'wrong' } })).status, 401)
    assert.equal((await fetch(url)).status, 401)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the agent key is not a panel credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const server = await harness({ configPath: join(dir, 'config.json'), config: { apiKey: 'panel-key', agentKey: 'agent-key', panelAuth: true } })
  try {
    // Agents must not be able to reach the management API with their key.
    assert.equal((await fetch(`${server.base}/panel/api/overview`, { headers: { authorization: 'Bearer agent-key' } })).status, 401)
    // The panel key still opens it.
    assert.equal((await fetch(`${server.base}/panel/api/overview`, { headers: { authorization: 'Bearer panel-key' } })).status, 200)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the auth endpoint exposes both keys separately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const server = await harness({ configPath: join(dir, 'config.json'), config: { apiKey: 'panel-key', agentKey: 'agent-key', panelAuth: true } })
  try {
    const body = (await (await fetch(`${server.base}/panel/api/auth`, {
      headers: { authorization: 'Bearer panel-key' },
    })).json()) as { key: string; agent: { key: string; enabled: boolean } }
    assert.equal(body.key, 'panel-key')
    assert.equal(body.agent.key, 'agent-key')
    assert.equal(body.agent.enabled, true)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rotating the agent key leaves the panel key working', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const server = await harness({ configPath: join(dir, 'config.json'), config: { apiKey: 'panel-key', agentKey: 'agent-key', panelAuth: true } })
  try {
    const rotated = (await (await fetch(`${server.base}/panel/api/auth/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer panel-key' },
      body: JSON.stringify({ target: 'agent' }),
    })).json()) as { target: string; key: string; path: string }
    assert.equal(rotated.target, 'agent')
    assert.notEqual(rotated.key, 'agent-key')

    // The new agent key works, the old one is dead…
    assert.equal((await fetch(`${server.base}/v1/models`, { headers: { 'x-api-key': rotated.key } })).status, 200)
    assert.equal((await fetch(`${server.base}/v1/models`, { headers: { 'x-api-key': 'agent-key' } })).status, 401)
    // …and the operator is still logged into the panel.
    assert.equal((await fetch(`${server.base}/panel/api/overview`, { headers: { authorization: 'Bearer panel-key' } })).status, 200)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the real asset loader serves both files from disk', async () => {
  // The API tests inject stub assets, so nothing there would catch a broken
  // loader. This exercises createAssets against the shipped panel directory.
  const dir = fileURLToPath(new URL('../panel', import.meta.url))
  const assets = createAssets(dir)
  const html = await assets.html()
  const js = await assets.js()
  assert.match(html, /<title>opencodez-free/)
  // The page must reference the script the loader serves.
  assert.match(html, /<script src="app\.js">/)
  assert.ok(js.length > 1000)
  // Both keys are surfaced in the UI, since an operator has to copy them.
  assert.match(html, /Agent 接入密钥/)
  assert.match(html, /id="keyAgent"/)
})

test('the shipped panel page contains no inline script', async () => {
  // A stricter CSP would block an inline block silently, so the page must load
  // its logic from app.js only.
  const html = await createAssets(fileURLToPath(new URL('../panel', import.meta.url))).html()
  const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)
  assert.equal(inline, false, 'panel/index.html contains an inline script block')
})

test('the panel opens without a key by default while /v1 still requires one', async () => {
  // The default posture: the panel is a local view of your own service, so it
  // does not ask for a password; the API port is reachable by anything on the
  // machine, so Agents must present the agent key.
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const server = await harness({ configPath: join(dir, 'config.json'), config: { agentKey: 'agent-key' } })
  try {
    // Panel page and its API are open.
    assert.equal((await fetch(`${server.base}/panel/`)).status, 200)
    assert.equal((await fetch(`${server.base}/panel/api/overview`)).status, 200)
    assert.equal((await fetch(`${server.base}/panel/api/config`)).status, 200)
    // The agent key is reported, but there is no panel credential to present.
    const auth = (await (await fetch(`${server.base}/panel/api/auth`)).json()) as {
      enabled: boolean
      key: string
      agent: { enabled: boolean; key: string }
    }
    assert.equal(auth.enabled, false)
    assert.equal(auth.key, '')
    assert.equal(auth.agent.enabled, true)
    assert.equal(auth.agent.key, 'agent-key')
    // /v1 is still protected.
    assert.equal((await fetch(`${server.base}/v1/models`)).status, 401)
    assert.equal((await fetch(`${server.base}/v1/models`, { headers: { 'x-api-key': 'agent-key' } })).status, 200)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rotating the panel key enables panel auth when it was off', async () => {
  // With panel auth off there is no panel key yet, so this button is the only
  // way to obtain one — it must mint and switch the check on in one step.
  const dir = await mkdtemp(join(tmpdir(), 'o2f-cfg-'))
  const server = await harness({ configPath: join(dir, 'config.json'), config: { agentKey: 'agent-key' } })
  try {
    assert.equal(server.getLive().panelAuth, false)
    // Open before enabling.
    assert.equal((await fetch(`${server.base}/panel/api/overview`)).status, 200)

    const rotated = (await (await fetch(`${server.base}/panel/api/auth/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'panel' }),
    })).json()) as { key: string; enabled: boolean }
    assert.ok(rotated.key.length > 0)
    assert.equal(rotated.enabled, true)
    assert.equal(server.getLive().panelAuth, true)
    assert.equal(server.getLive().panelKey, rotated.key)

    // Now gated: the new key opens it, no key does not.
    assert.equal((await fetch(`${server.base}/panel/api/overview`)).status, 401)
    assert.equal(
      (await fetch(`${server.base}/panel/api/overview`, { headers: { authorization: `Bearer ${rotated.key}` } })).status,
      200,
    )
    // The agent credential is untouched by a panel change.
    assert.equal((await fetch(`${server.base}/v1/models`, { headers: { 'x-api-key': 'agent-key' } })).status, 200)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearing the recent view does not reset usage totals', async () => {
  const server = await harness()
  try {
    await fetch(`${server.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await fetch(`${server.base}/panel/api/stats/reset`, { method: 'POST', body: '{}' })
    const body = (await (await fetch(`${server.base}/panel/api/overview`)).json()) as {
      usage: { requests: number }
      recent: unknown[]
    }
    assert.equal(body.recent.length, 0)
    // The lifetime figures must survive a display-only reset.
    assert.equal(body.usage.requests, 1)
  } finally {
    await server.close()
  }
})

test('an unknown panel path is a JSON 404', async () => {
  const server = await harness()
  try {
    const response = await fetch(`${server.base}/panel/api/nonsense`)
    assert.equal(response.status, 404)
    assert.match(((await response.json()) as { error: string }).error, /unknown panel path/)
  } finally {
    await server.close()
  }
})

test('the root document advertises the panel when enabled', async () => {
  const server = await harness()
  try {
    const body = (await (await fetch(`${server.base}/`)).json()) as { panel: string | null }
    assert.equal(body.panel, '/panel/')
  } finally {
    await server.close()
  }
})

test('disabling the panel removes the endpoint entirely', async () => {
  const config = resolveConfig({ port: 0, panel: false })
  const catalog = new ModelCatalog({ fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }) })
  const upstream = new ZenUpstream({ fetchImpl: async () => new Response('', { status: 200 }) })
  const app = createApp({ config, catalog, upstream, log: () => {} })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', () => resolve()))
  const port = (app.address() as AddressInfo).port
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/panel/`)).status, 404)
    const root = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as { panel: string | null }
    assert.equal(root.panel, null)
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()))
  }
})
