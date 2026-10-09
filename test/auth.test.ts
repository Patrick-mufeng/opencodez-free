import { strict as assert } from 'node:assert'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  API_KEY_HEADERS,
  extractToken,
  tokenMatches,
} from '../src/httpauth.ts'
import {
  API_KEY_PREFIX,
  defaultAgentKeyPath,
  generateApiKey,
  resolveAuth,
  resolveConfig,
  resolveKeys,
} from '../src/config.ts'

/**
 * Client-key resolution: the service ships with authentication ON, so the
 * interesting cases are where each key comes from and whether they stay
 * independent.
 */

test('every common credential header is accepted', () => {
  // Agent clients disagree on the header; an integration must not be turned
  // away because it sends x-api-key instead of an OpenAI-style bearer token.
  assert.equal(extractToken({ authorization: 'Bearer abc' }), 'abc')
  assert.equal(extractToken({ authorization: 'bearer abc' }), 'abc')
  // A bare value: some gateways drop the scheme.
  assert.equal(extractToken({ authorization: 'abc' }), 'abc')
  assert.equal(extractToken({ 'x-api-key': 'abc' }), 'abc')
  assert.equal(extractToken({ 'api-key': 'abc' }), 'abc')
  // Authorization wins when several are present.
  assert.equal(extractToken({ authorization: 'Bearer first', 'x-api-key': 'second' }), 'first')
})

test('array-valued headers take their first entry', () => {
  assert.equal(extractToken({ 'x-api-key': ['abc', 'def'] }), 'abc')
})

test('no credential header yields an empty token', () => {
  assert.equal(extractToken({}), '')
  assert.equal(extractToken({ authorization: '' }), '')
  assert.equal(extractToken({ authorization: 'Bearer   ' }), '')
})

test('the header list covers the documented spellings', () => {
  assert.deepEqual([...API_KEY_HEADERS], ['x-api-key', 'api-key'])
})

test('token comparison is exact and rejects empties', () => {
  assert.equal(tokenMatches('abc', 'abc'), true)
  assert.equal(tokenMatches('abc', 'abd'), false)
  assert.equal(tokenMatches('abc', 'abcd'), false)
  // An empty expectation means auth is off, never "match anything".
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches('abc', ''), false)
})

test('auth is on by default', () => {
  assert.equal(resolveConfig().auth, true)
})

test('a generated key is prefixed, long, and unique', () => {
  const first = generateApiKey()
  const second = generateApiKey()
  assert.ok(first.startsWith(API_KEY_PREFIX))
  // 24 random bytes as base64url is 32 characters.
  assert.equal(first.length, API_KEY_PREFIX.length + 32)
  assert.notEqual(first, second)
})

test('a missing key file is generated and persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  const keyPath = join(dir, 'api-key.txt')
  try {
    const first = await resolveAuth(resolveConfig({ panelAuth: true }), keyPath)
    assert.equal(first.source, 'generated')
    assert.ok(first.key.length > 0)

    // The file holds exactly the key, so it can be read back by hand.
    assert.equal((await readFile(keyPath, 'utf8')).trim(), first.key)

    // A second start reuses it rather than rotating clients off.
    const second = await resolveAuth(resolveConfig({ panelAuth: true }), keyPath)
    assert.equal(second.source, 'stored')
    assert.equal(second.key, first.key)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an explicit key is used verbatim and never overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  const keyPath = join(dir, 'api-key.txt')
  try {
    // A persisted generated key already exists…
    await writeFile(keyPath, 'ozk_stored_stored_stored\n', 'utf8')
    // …but configuration wins over it.
    const resolved = await resolveAuth(resolveConfig({ panelAuth: true, apiKey: 'pinned-key' }), keyPath)
    assert.equal(resolved.source, 'configured')
    assert.equal(resolved.key, 'pinned-key')
    // The file is left alone, so removing the override restores the old key.
    assert.equal((await readFile(keyPath, 'utf8')).trim(), 'ozk_stored_stored_stored')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auth off disables the key even when one is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  try {
    const resolved = await resolveAuth(resolveConfig({ panelAuth: false, apiKey: 'ignored' }), join(dir, 'k.txt'), false)
    assert.equal(resolved.source, 'disabled')
    assert.equal(resolved.key, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable key file falls back to generating a new one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  const keyPath = join(dir, 'sub', 'api-key.txt')
  try {
    // The parent directory does not exist yet; resolveAuth must create it.
    const resolved = await resolveAuth(resolveConfig({ panelAuth: true }), keyPath)
    assert.equal((await readFile(keyPath, 'utf8')).trim(), resolved.key)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the agent and panel keys are separate files with separate values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  const paths = { panel: join(dir, 'api-key.txt'), agent: join(dir, 'agent-key.txt') }
  try {
    const keys = await resolveKeys(resolveConfig({ panelAuth: true }), paths)
    assert.equal(keys.panel.source, 'generated')
    assert.equal(keys.agent.source, 'generated')
    // Distinct credentials: rotating one must not invalidate the other.
    assert.notEqual(keys.panel.key, keys.agent.key)
    assert.equal((await readFile(paths.panel, 'utf8')).trim(), keys.panel.key)
    assert.equal((await readFile(paths.agent, 'utf8')).trim(), keys.agent.key)

    // Both are reused on a later start.
    const again = await resolveKeys(resolveConfig({ panelAuth: true }), paths)
    assert.equal(again.panel.key, keys.panel.key)
    assert.equal(again.agent.key, keys.agent.key)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('panel auth is off by default, so no panel credential is produced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  const paths = { panel: join(dir, 'api-key.txt'), agent: join(dir, 'agent-key.txt') }
  try {
    const keys = await resolveKeys(resolveConfig(), paths)
    // The API still requires a key…
    assert.equal(keys.agent.source, 'generated')
    assert.ok(keys.agent.key.length > 0)
    // …but the panel does not, and no panel key file is written.
    assert.equal(keys.panel.source, 'disabled')
    assert.equal(keys.panel.key, '')
    await assert.rejects(() => readFile(paths.panel, 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an existing panel key file is ignored while panel auth is off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  const paths = { panel: join(dir, 'api-key.txt'), agent: join(dir, 'agent-key.txt') }
  try {
    await writeFile(paths.panel, 'ozk_leftover_leftover_leftover\n', 'utf8')
    const keys = await resolveKeys(resolveConfig(), paths)
    // A stale file must not silently re-enable the check.
    assert.equal(keys.panel.key, '')
    assert.equal(keys.panel.source, 'disabled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an existing single-key install keeps its agents working', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  const paths = { panel: join(dir, 'api-key.txt'), agent: join(dir, 'agent-key.txt') }
  try {
    // The pre-split layout: only a panel key exists, and agents were already
    // configured with it.
    await writeFile(paths.panel, 'ozk_legacy_legacy_legacy_legacy\n', 'utf8')
    const keys = await resolveKeys(resolveConfig(), paths)
    // Minting a different agent key here would silently disconnect every agent.
    assert.equal(keys.agent.key, 'ozk_legacy_legacy_legacy_legacy')
    // The agent file is created so a later rotation has somewhere to write.
    assert.equal((await readFile(paths.agent, 'utf8')).trim(), keys.agent.key)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an explicit agent key wins over the stored one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  const paths = { panel: join(dir, 'api-key.txt'), agent: join(dir, 'agent-key.txt') }
  try {
    await writeFile(paths.agent, 'ozk_stored_agent_key_here_xx\n', 'utf8')
    const keys = await resolveKeys(resolveConfig({ agentKey: 'pinned-agent' }), paths)
    assert.equal(keys.agent.source, 'configured')
    assert.equal(keys.agent.key, 'pinned-agent')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auth off disables both keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o2f-auth-'))
  try {
    const keys = await resolveKeys(resolveConfig({ auth: false }), {
      panel: join(dir, 'p.txt'),
      agent: join(dir, 'a.txt'),
    })
    assert.equal(keys.panel.key, '')
    assert.equal(keys.agent.key, '')
    assert.equal(keys.panel.source, 'disabled')
    assert.equal(keys.agent.source, 'disabled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the default agent key path sits beside the panel key', () => {
  assert.match(defaultAgentKeyPath(), /agent-key\.txt$/)
})

test('the auth flag and keys round-trip through the environment', () => {
  const off = resolveConfig({}, { OPENCODEZ_AUTH: 'false' } as NodeJS.ProcessEnv)
  assert.equal(off.auth, false)
  const on = resolveConfig({}, {
    OPENCODEZ_AUTH: '1',
    OPENCODEZ_API_KEY: 'env-panel',
    OPENCODEZ_AGENT_KEY: 'env-agent',
  } as NodeJS.ProcessEnv)
  assert.equal(on.auth, true)
  assert.equal(on.apiKey, 'env-panel')
  assert.equal(on.agentKey, 'env-agent')
})

test('the config file apiKey field is honoured', () => {
  const config = resolveConfig({ apiKey: 'from-file' })
  assert.equal(config.apiKey, 'from-file')
  // A blank field is the "use the generated key" case, not an error.
  assert.equal(resolveConfig({ apiKey: '' }).apiKey, '')
})
