import { strict as assert } from 'node:assert'
import test from 'node:test'

import { readConfigFile, resolveConfig, defaultConfigPath } from '../src/config.ts'

test('defaults bind to loopback with no auth', () => {
  const config = resolveConfig()
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 8787)
  assert.equal(config.apiKey, '')
})

test('a config file value overrides the default', () => {
  const config = resolveConfig({ port: 9000, host: '0.0.0.0' })
  assert.equal(config.port, 9000)
  assert.equal(config.host, '0.0.0.0')
})

test('environment variables beat the file, flags beat the environment', () => {
  const env = { OPENCODEZ_PORT: '9100' } as NodeJS.ProcessEnv
  assert.equal(resolveConfig({ port: 9000 }, env).port, 9100)
  assert.equal(resolveConfig({ port: 9000 }, env, { port: 9200 }).port, 9200)
})

test('a port of zero is preserved so the OS can pick one', () => {
  assert.equal(resolveConfig({ port: 0 }).port, 0)
})

test('numeric strings from the environment are coerced', () => {
  const config = resolveConfig({}, { OPENCODEZ_PORT: '9500', OPENCODEZ_REFRESH_SECONDS: '600' } as NodeJS.ProcessEnv)
  assert.equal(config.port, 9500)
  assert.equal(config.refreshSeconds, 600)
})

test('invalid numbers fall back rather than producing NaN', () => {
  const config = resolveConfig({ port: 'not-a-number', firstEventMs: 'nonsense' })
  assert.equal(config.port, 8787)
  assert.equal(config.firstEventMs, 60_000)
})

test('watchdog windows are clamped to a sane range', () => {
  assert.equal(resolveConfig({ firstEventMs: 1 }).firstEventMs, 1000)
  assert.equal(resolveConfig({ firstEventMs: 99_999_999 }).firstEventMs, 600_000)
})

test('the refresh cadence cannot be set absurdly low', () => {
  assert.equal(resolveConfig({ refreshSeconds: 1 }).refreshSeconds, 30)
})

test('boolean strings are coerced', () => {
  assert.equal(resolveConfig({ exposeAllModels: 'true' }).exposeAllModels, true)
  assert.equal(resolveConfig({ exposeAllModels: 'false' }).exposeAllModels, false)
  assert.equal(resolveConfig({}, { OPENCODEZ_EXPOSE_ALL_MODELS: 'yes' } as NodeJS.ProcessEnv).exposeAllModels, true)
})

test('an unknown log level falls back to info', () => {
  assert.equal(resolveConfig({ logLevel: 'chatty' }).logLevel, 'info')
  assert.equal(resolveConfig({ logLevel: 'debug' }).logLevel, 'debug')
})

test('the zen base url is normalised without a trailing slash', () => {
  assert.equal(resolveConfig({ zenBaseUrl: 'https://example.com/zen///' }).zenBaseUrl, 'https://example.com/zen')
})

test('the config path honours the environment override', () => {
  const previous = process.env.OPENCODEZ_CONFIG
  process.env.OPENCODEZ_CONFIG = 'C:\\tmp\\custom.json'
  try {
    assert.match(defaultConfigPath(), /custom\.json$/)
  } finally {
    if (previous === undefined) delete process.env.OPENCODEZ_CONFIG
    else process.env.OPENCODEZ_CONFIG = previous
  }
})

test('a missing config file reads as empty rather than throwing', async () => {
  const result = await readConfigFile('C:\\definitely\\not\\here\\config.json')
  assert.deepEqual(result, {})
})

test('the api key is trimmed', () => {
  assert.equal(resolveConfig({ apiKey: '  secret  ' }).apiKey, 'secret')
})
