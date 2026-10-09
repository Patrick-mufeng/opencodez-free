import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  canonicalSessionID,
  conversationSeed,
  deriveRequestIDs,
  disguiseHeaders,
  randomID,
  stableID,
} from '../src/ids.ts'

test('stableID is deterministic and prefixed', () => {
  const first = stableID('prj', 'value')
  assert.equal(first, stableID('prj', 'value'))
  assert.match(first, /^prj_[0-9a-f]{24}$/)
  assert.notEqual(first, stableID('prj', 'other'))
})

test('randomID carries the prefix and the requested byte count', () => {
  const id = randomID('req', 16)
  assert.match(id, /^req_[0-9a-f]{32}$/)
  assert.notEqual(id, randomID('req', 16))
})

test('canonicalSessionID folds any signal into the upstream session shape', () => {
  const canonical = canonicalSessionID('some conversation signal')
  // The shape the free lane requires: ses_ + 12 hex + 14 base62.
  assert.match(canonical, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  // Deterministic, so prompt-cache affinity survives across turns.
  assert.equal(canonical, canonicalSessionID('some conversation signal'))
  assert.notEqual(canonical, canonicalSessionID('a different signal'))
})

test('canonicalSessionID passes an already-canonical id through untouched', () => {
  const official = 'ses_0123456789ab' + 'ABCDEFGHIJKLMN'
  assert.equal(canonicalSessionID(official), official)
})

test('conversationSeed keys on the first user turn', () => {
  const messages = [
    { role: 'system', content: 'ignored' },
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
  ]
  assert.equal(conversationSeed(messages), '"first"')
})

test('conversationSeed ignores empty and absent content', () => {
  assert.equal(conversationSeed([]), '')
  assert.equal(conversationSeed([{ role: 'user', content: null }]), '')
  assert.equal(conversationSeed([{ role: 'assistant', content: 'x' }]), '')
})

test('deriveRequestIDs produces one stable session and a fresh request id', () => {
  const messages = [{ role: 'user', content: 'hello' }]
  const first = deriveRequestIDs(messages)
  const second = deriveRequestIDs(messages)
  assert.equal(first.session, second.session)
  assert.notEqual(first.request, second.request)
  assert.match(first.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('deriveRequestIDs honours an explicit session override', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }], { session: 'my-session' })
  assert.equal(ids.session, canonicalSessionID('my-session'))
})

test('disguiseHeaders carries the full CLI identity set', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hi' }])
  const headers = disguiseHeaders(ids)
  assert.match(headers['user-agent'], /^opencode\//)
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], ids.session)
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['X-Session-Id'], ids.session)
  assert.equal(headers['x-opencode-request'], ids.request)
  assert.equal(headers['x-opencode-project'], ids.project)
})
