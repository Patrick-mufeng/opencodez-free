import { strict as assert } from 'node:assert'
import test from 'node:test'

import { classifyFailure, isEffortRejection, shouldRotate, SseParser, ZenUpstream } from '../src/upstream.ts'

test('failure classification recognises the upstream error vocabulary', () => {
  assert.equal(classifyFailure('RegionError: not available in your country'), 'region_blocked')
  assert.equal(classifyFailure('FreeTierError: free tier can only be used from within OpenCode'), 'free_tier')
  assert.equal(classifyFailure('upstream returned 401'), 'auth')
  assert.equal(classifyFailure('HTTP 429 rate limit exceeded'), 'rate_limit')
  assert.equal(classifyFailure('upstream 503 Service Unavailable'), 'server')
  assert.equal(classifyFailure('request timed out'), 'timeout')
  assert.equal(classifyFailure('ECONNRESET while reading'), 'transport')
  assert.equal(classifyFailure('something else entirely'), 'upstream')
})

test('a region block is never retried, transient failures are', () => {
  // A region block is deterministic for this machine: a new session id cannot
  // change the source address.
  assert.equal(shouldRotate('region_blocked', true), false)
  assert.equal(shouldRotate('transport', false), true)
  assert.equal(shouldRotate('timeout', false), true)
  assert.equal(shouldRotate('server', false), true)
  assert.equal(shouldRotate('auth', false), false)
})

test('the SSE parser reads frames split across chunk boundaries', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: {"a"'), [])
  const events = parser.push(':1}\n\n')
  assert.equal(events.length, 1)
  assert.equal(events[0]!.data, '{"a":1}')
})

test('the SSE parser drops keep-alive comments', () => {
  const parser = new SseParser()
  // Upstream emits these while it warms up; they are not model output.
  const events = parser.push(': keep-alive\n\n: keep-alive\n\ndata: {"a":1}\n\n')
  assert.equal(events.length, 1)
  assert.equal(events[0]!.data, '{"a":1}')
})

test('the SSE parser handles CRLF and multi-line data frames', () => {
  const parser = new SseParser()
  const events = parser.push('event: delta\r\ndata: line1\r\ndata: line2\r\n\r\n')
  assert.equal(events.length, 1)
  assert.equal(events[0]!.event, 'delta')
  assert.equal(events[0]!.data, 'line1\nline2')
})

test('the SSE parser flushes a trailing frame with no blank line', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: [DONE]'), [])
  const events = parser.end()
  assert.equal(events.length, 1)
  assert.equal(events[0]!.data, '[DONE]')
})

test('the SSE parser yields several frames from one chunk', () => {
  const parser = new SseParser()
  const events = parser.push('data: 1\n\ndata: 2\n\ndata: 3\n\n')
  assert.deepEqual(events.map((event) => event.data), ['1', '2', '3'])
})

test('the outgoing body always streams and always carries the gate tools', () => {
  const upstream = new ZenUpstream()
  const body = upstream.shapeBody({ model: 'mimo-v2.6-flash-free', stream: false, messages: [{ role: 'user', content: 'hi' }] }, 'mimo-v2.6-flash-free')
  // The lane refuses non-streaming bodies, so the flag is forced.
  assert.equal(body.stream, true)
  const tools = body.tools as Array<{ function: { name: string } }>
  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ['bash', 'read'])
})

test('a selected effort rides the outgoing body in the accepted spelling', () => {
  const upstream = new ZenUpstream()
  const body = upstream.shapeBody(
    { model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'off' },
    'mimo-v2.6-flash-free',
  )
  assert.equal(body.reasoning_effort, 'none')
  // The camelCase input spelling is consumed, not forwarded.
  assert.equal(body.reasoningEffort, undefined)
})

test('an invalid effort is not injected into the outgoing body', () => {
  const upstream = new ZenUpstream()
  const body = upstream.shapeBody(
    { model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'nonsense' },
    'mimo-v2.6-flash-free',
  )
  assert.equal(body.reasoning_effort, undefined)
})

test('a responses body nests the effort and gets flat gate tools', () => {
  const upstream = new ZenUpstream()
  const body = upstream.shapeBody(
    { model: 'muse-spark-1.2-contributor-free', input: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'high' } },
    'muse-spark-1.2-contributor-free',
  )
  assert.deepEqual(body.reasoning, { effort: 'high' })
  assert.equal(body.tool_choice, 'auto')
  const tools = body.tools as Array<{ name: string }>
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['bash', 'read'])
})

test('a responses body accepts the flat effort spelling too', () => {
  const upstream = new ZenUpstream()
  const body = upstream.shapeBody(
    { model: 'muse-spark-1.2-contributor-free', input: [], reasoning_effort: 'low' },
    'muse-spark-1.2-contributor-free',
  )
  assert.deepEqual(body.reasoning, { effort: 'low' })
})

test('an off effort is dropped on the responses path, which has no none', () => {
  const upstream = new ZenUpstream()
  const body = upstream.shapeBody(
    { model: 'muse-spark-1.2-contributor-free', input: [], reasoning: { effort: 'none' } },
    'muse-spark-1.2-contributor-free',
  )
  // The gateway would reject `none` here, so nothing is sent rather than a bad value.
  assert.equal(body.reasoning, undefined)
})

test('the endpoint follows the model family', () => {
  const upstream = new ZenUpstream()
  assert.equal(upstream.pathFor('mimo-v2.6-flash-free'), '/v1/chat/completions')
  assert.equal(upstream.pathFor('muse-spark-1.3-contributor-free'), '/v1/responses')
})

test('watchdog windows widen for responses models', () => {
  const upstream = new ZenUpstream({ bodyIdleMs: 120_000, responsesBodyIdleMs: 300_000 })
  assert.equal(upstream.watchdogs('mimo-v2.6-flash-free').bodyIdleMs, 120_000)
  assert.equal(upstream.watchdogs('muse-spark-1.3-contributor-free').bodyIdleMs, 300_000)
  assert.equal(upstream.watchdogs('mimo-v2.6-flash-free').firstEventMs, upstream.watchdogs('muse-spark-1.3-contributor-free').firstEventMs)
})

test('the responses floor never drops below the chat window', () => {
  const upstream = new ZenUpstream({ bodyIdleMs: 400_000, responsesBodyIdleMs: 300_000 })
  assert.equal(upstream.watchdogs('muse-spark-1.3-contributor-free').bodyIdleMs, 400_000)
})

test('a successful request returns the response without retrying', async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async () => {
    calls++
    return new Response('data: {}\n\n', { status: 200 })
  }
  const upstream = new ZenUpstream({ fetchImpl })
  const handle = await upstream.stream({ body: { messages: [{ role: 'user', content: 'hi' }] }, model: 'mimo-v2.6-flash-free' })
  assert.equal(calls, 1)
  assert.equal(handle.attempts, 1)
  assert.match(handle.ids.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('a transient HTTP failure is retried on a fresh identity', async () => {
  const sessions: string[] = []
  let calls = 0
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls++
    sessions.push(String((init?.headers as Record<string, string>)['x-opencode-session']))
    if (calls === 1) return new Response('upstream 503 overloaded', { status: 503 })
    return new Response('data: {}\n\n', { status: 200 })
  }
  const upstream = new ZenUpstream({ fetchImpl })
  const handle = await upstream.stream({ body: { messages: [{ role: 'user', content: 'hi' }] }, model: 'mimo-v2.6-flash-free' })
  assert.equal(calls, 2)
  assert.equal(handle.attempts, 2)
})

test('a region block surfaces immediately without retrying', async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async () => {
    calls++
    return new Response(JSON.stringify({ type: 'error', error: { type: 'RegionError', message: 'not available in your country' } }), {
      status: 403,
    })
  }
  const upstream = new ZenUpstream({ fetchImpl })
  await assert.rejects(
    () => upstream.stream({ body: { messages: [{ role: 'user', content: 'hi' }] }, model: 'muse-spark-1.2-contributor-free' }),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 403)
      assert.match(err.message, /not available in your country/i)
      return true
    },
  )
  // Deterministic failure: one attempt, no retries.
  assert.equal(calls, 1)
})

test('exhausting the retry budget reports the attempt story', async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async () => {
    calls++
    return new Response('upstream 502 bad gateway', { status: 502 })
  }
  const upstream = new ZenUpstream({ fetchImpl, maxRotates: 2 })
  await assert.rejects(
    () => upstream.stream({ body: { messages: [{ role: 'user', content: 'hi' }] }, model: 'mimo-v2.6-flash-free' }),
    (err: Error & { attempts?: number; detail?: string }) => {
      assert.equal(err.attempts, 3)
      assert.match(err.detail ?? '', /#1/)
      return true
    },
  )
  assert.equal(calls, 3)
})

test('a model rejecting the effort value is retried without it', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    // Models carry per-model ladders; this is the shape of a real rejection.
    if (body.reasoning_effort !== undefined) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Upstream request failed: [invalid_request_error] Model does not support reasoning_effort \'none\'; supported values: low, medium, high, xhigh.',
          },
        }),
        { status: 400 },
      )
    }
    return new Response('data: {}\n\n', { status: 200 })
  }
  const upstream = new ZenUpstream({ fetchImpl })
  const handle = await upstream.stream({
    body: { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'off' },
    model: 'mimo-v2.6-flash-free',
  })
  assert.equal(handle.attempts, 2)
  // The first attempt carried the value we asked for; the retry dropped it.
  assert.equal(bodies[0]!.reasoning_effort, 'none')
  assert.equal(bodies[1]!.reasoning_effort, undefined)
})

test('an effort rejection on the responses path drops only the nested field', () => {
  const upstream = new ZenUpstream()
  const shaped = upstream.shapeBody(
    { model: 'muse-spark-1.2-contributor-free', input: [], reasoning: { effort: 'high', summary: 'auto' } },
    'muse-spark-1.2-contributor-free',
  )
  const without = upstream.withoutEffort(shaped, 'muse-spark-1.2-contributor-free')
  assert.equal((without.reasoning as Record<string, unknown>).effort, undefined)
  // The other reasoning fields must survive the rewrite.
  assert.equal((without.reasoning as Record<string, unknown>).summary, 'auto')
})

test('isEffortRejection recognises the upstream wording', () => {
  assert.ok(isEffortRejection("Model does not support reasoning_effort 'none'; supported values: low, high"))
  assert.ok(isEffortRejection('reasoning_effort: Invalid option: expected one of "low"|"high"'))
  assert.ok(isEffortRejection('the reasoning effort value is unsupported'))
  // Unrelated failures must not be mistaken for an effort problem.
  assert.ok(!isEffortRejection('Endpoint is unavailable.'))
  assert.ok(!isEffortRejection('rate limit exceeded'))
})
