import { strict as assert } from 'node:assert'
import test from 'node:test'

import { ModelCatalog } from '../src/catalog.ts'
import { ModelProbe } from '../src/probe.ts'
import { upstreamErrorMessage, ZenUpstream } from '../src/upstream.ts'

/** A catalog stub whose roster is fixed, so probes do not touch the network. */
function stubCatalog(models: string[]): ModelCatalog {
  const catalog = new ModelCatalog()
  Object.defineProperty(catalog, 'list', { value: () => [...models] })
  return catalog
}

/** An upstream stub that streams a canned chat completion. */
function okUpstream(text = 'ok', over: { usage?: unknown } = {}): ZenUpstream {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      [
        `data: ${JSON.stringify({ id: 'g', model: 'm', choices: [{ index: 0, delta: { content: text } }] })}`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: over.usage ?? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  return new ZenUpstream({ fetchImpl, firstEventMs: 3000, bodyIdleMs: 3000 })
}

test('a successful probe reports latency, output, and ok status', async () => {
  const probe = new ModelProbe(okUpstream('hello'), stubCatalog(['m']))
  const result = await probe.probe('m')
  assert.equal(result.status, 'ok')
  assert.equal(result.chars, 5)
  assert.ok((result.ttft_ms ?? 0) >= 0)
  assert.ok((result.total_ms ?? 0) >= 0)
})

test('the probe request carries no reasoning effort and a workable budget', async () => {
  let sent: Record<string, unknown> = {}
  const fetchImpl: typeof fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
      status: 200,
    })
  }
  const probe = new ModelProbe(new ZenUpstream({ fetchImpl }), stubCatalog(['m']))
  await probe.probe('m')
  // Several free models reject effort values outside their own ladder, so the
  // probe sends none and lets the provider default apply.
  assert.equal(sent.reasoning_effort, undefined)
  // The budget must be large enough that a thinking model still answers.
  assert.ok(typeof sent.max_tokens === 'number' && sent.max_tokens >= 256)
})

test('a model that returns no text is reported as empty, not as success', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\ndata: [DONE]\n\n`, {
      status: 200,
    })
  const probe = new ModelProbe(new ZenUpstream({ fetchImpl }), stubCatalog(['m']))
  const result = await probe.probe('m')
  assert.equal(result.status, 'fail')
  assert.equal(result.error, 'empty')
  assert.match(result.detail ?? '', /without producing any text/)
})

test('an in-stream error frame is reported with its reason', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(`data: ${JSON.stringify({ error: { message: 'stream body idle timeout (upstream went silent mid-response)', type: 'upstream_timeout' } })}\n\ndata: [DONE]\n\n`, {
      status: 200,
    })
  const probe = new ModelProbe(new ZenUpstream({ fetchImpl }), stubCatalog(['m']))
  const result = await probe.probe('m')
  assert.equal(result.status, 'fail')
  // A watchdog teardown is a timeout, not an unexplained failure.
  assert.equal(result.error, 'timeout')
  assert.match(result.detail ?? '', /idle timeout/)
})

test('an upstream HTTP failure is classified', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { type: 'RegionError', message: 'not available in your country' } }), { status: 403 })
  const probe = new ModelProbe(new ZenUpstream({ fetchImpl }), stubCatalog(['m']))
  const result = await probe.probe('m')
  assert.equal(result.status, 'fail')
  assert.equal(result.error, 'error')
  assert.match(result.detail ?? '', /not available in your country/i)
})

test('a probe timeout is reported as such', async () => {
  // A stream that sends headers then stalls forever.
  const fetchImpl: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'))
        },
      }),
      { status: 200 },
    )
  const probe = new ModelProbe(new ZenUpstream({ fetchImpl, firstEventMs: 10_000, bodyIdleMs: 10_000 }), stubCatalog(['m']), {
    timeoutMs: 300,
  })
  const result = await probe.probe('m')
  assert.equal(result.status, 'fail')
  assert.equal(result.error, 'timeout')
})

test('a batch run walks the whole roster and reports progress', async () => {
  const probe = new ModelProbe(okUpstream('ok'), stubCatalog(['a', 'b', 'c']), { concurrency: 2 })
  const events: string[] = []
  probe.onEvent((event) => events.push(event.kind))
  const queue = probe.start()
  assert.equal(queue.length, 3)
  assert.equal(probe.running, true)
  // Wait for the drain to settle.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(probe.running, false)
  const progress = probe.progress()
  assert.equal(progress.total, 3)
  assert.equal(progress.done, 3)
  assert.equal(progress.failed, 0)
  assert.ok(events.includes('started'))
  assert.ok(events.includes('finished'))
})

test('batch failures are counted and the queue marks them', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500 })
  const probe = new ModelProbe(new ZenUpstream({ fetchImpl }), stubCatalog(['a', 'b']), { concurrency: 2 })
  probe.start()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const progress = probe.progress()
  assert.equal(progress.done, 2)
  assert.equal(progress.failed, 2)
  assert.ok(probe.queue().every((item) => item.status === 'error'))
})

test('starting a batch seeds queued models as pending', async () => {
  // More models than the concurrency, so some are still waiting when start()
  // returns.
  const probe = new ModelProbe(okUpstream(), stubCatalog(['x', 'y', 'z', 'w', 'v']), { concurrency: 1 })
  probe.start()
  const pending = probe.results().filter((r) => r.status === 'pending')
  assert.ok(pending.length >= 1, 'expected queued models to show as pending')
  // Let the drain finish so the test does not leave work running.
  await new Promise((resolve) => setTimeout(resolve, 400))
})

test('concurrency is clamped to a sane range', () => {
  const probe = new ModelProbe(okUpstream(), stubCatalog([]))
  probe.setConcurrency(99)
  assert.equal(probe.concurrency, 8)
  probe.setConcurrency(0)
  assert.equal(probe.concurrency, 1)
  probe.setConcurrency(3)
  assert.equal(probe.concurrency, 3)
})

test('a responses-only model is probed through the responses shape', async () => {
  let sent: Record<string, unknown> = {}
  const fetchImpl: typeof fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\ndata: [DONE]\n\n`, { status: 200 })
  }
  const probe = new ModelProbe(new ZenUpstream({ fetchImpl }), stubCatalog(['muse-spark-1.3-contributor-free']))
  const result = await probe.probe('muse-spark-1.3-contributor-free')
  // The Responses shape carries `input`, not `messages`.
  assert.ok(Array.isArray(sent.input))
  assert.equal(sent.messages, undefined)
  assert.equal(result.status, 'ok')
})

test('upstreamErrorMessage unwraps the error envelopes the lane sends', () => {
  assert.equal(upstreamErrorMessage('{"error":{"message":"boom"}}'), 'boom')
  assert.equal(upstreamErrorMessage('{"error":{"type":"error","error":{"type":"x","message":"deep"}}}'), 'deep')
  assert.equal(upstreamErrorMessage('{"error":"string error"}'), 'string error')
  assert.equal(upstreamErrorMessage('plain text'), 'plain text')
  assert.equal(upstreamErrorMessage(''), '')
  // Unparseable bodies still yield something readable.
  assert.equal(upstreamErrorMessage('{"broken":'), '{"broken":')
})
