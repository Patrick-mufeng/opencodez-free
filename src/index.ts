#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ModelCatalog } from './catalog.ts'
import { resolveKeys, HELP_TEXT, parseArgs, type ServiceConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { LogRing } from './logring.ts'
import { createAssets, createPanel } from './panel.ts'
import { ModelProbe } from './probe.ts'
import { createApp } from './server.ts'
import { RecentRequests, StatsStore } from './stats.ts'
import { ZenUpstream } from './upstream.ts'

/**
 * Entry point: start the catalog, build the panel, start the HTTP server, print
 * the addresses a client should use, and shut down cleanly on a signal.
 */

const VERSION = '1.0.0'

/** The panel's static assets ship next to this file, under panel/. */
function panelDir(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'panel')
}

/**
 * A one-line summary of where a key came from. The key itself is not included:
 * it was already printed when generated, and repeating a secret on every start
 * would leave it in any log that gets pasted into an issue.
 */
function describeKey(resolved: { source: string; path: string }, label: string): string {
  switch (resolved.source) {
    case 'configured':
      return `${label} from configuration`
    case 'stored':
      return `${label} loaded from ${resolved.path}`
    case 'generated':
      return `${label} generated (see above)`
    default:
      return `${label} disabled`
  }
}

async function main(): Promise<void> {
  const { config, configPath, action } = await parseArgs(process.argv.slice(2))

  if (action === 'help') {
    process.stdout.write(HELP_TEXT)
    return
  }
  if (action === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  const logs = new LogRing(500)
  const log = createLogger(config, logs)

  // Client credentials: resolve before anything is served, so the first request
  // already sees the final keys.
  const keys = await resolveKeys(config)
  const liveConfig: ServiceConfig = {
    ...config,
    apiKey: keys.panel.key,
    panelKey: keys.panel.key,
    agentKey: keys.agent.key,
  }

  // Live config: the panel can rewrite it without a restart.
  let live: ServiceConfig = liveConfig

  const catalog = new ModelCatalog({
    refreshSeconds: config.refreshSeconds,
    zenBaseUrl: config.zenBaseUrl,
    metadataUrl: config.metadataUrl,
    cachePath: config.cachePath,
    onRefresh: (snapshot, lastError) => {
      log('debug', 'catalog refreshed', {
        status: snapshot.status,
        exposed: snapshot.exposed,
        live: snapshot.total,
        ...(lastError ? { error: lastError } : {}),
      })
    },
  })

  const upstream = new ZenUpstream({
    zenBaseUrl: config.zenBaseUrl,
    firstEventMs: config.firstEventMs,
    bodyIdleMs: config.bodyIdleMs,
    responsesBodyIdleMs: config.responsesBodyIdleMs,
    maxRotates: config.maxRotates,
    onAttempt: (info) => log('debug', 'upstream attempt', info),
  })

  const stats = new StatsStore({ path: config.statsPath, keepDays: config.statsKeepDays })
  await stats.load()
  const recent = new RecentRequests(50)

  log('info', 'resolving model catalog', {
    zen: config.zenBaseUrl,
    metadata: config.metadataUrl,
    exposeAll: config.exposeAllModels,
  })
  // Do not block startup on the network: the server must be able to explain its
  // own state while the first fetch is still in flight.
  const catalogReady = catalog.start()

  const probe = new ModelProbe(upstream, catalog, { concurrency: 2 })
  probe.onEvent((event) => {
    if (event.kind === 'finished') {
      const progress = probe.progress()
      log('info', `probe finished: ${progress.done - progress.failed}/${progress.total} ok`, { channel: 'task' })
    }
  })

  const startedAt = Date.now()
  const panel = config.panel
    ? createPanel(
        {
          config: liveConfig,
          configPath,
          catalog,
          probe,
          stats,
          recent,
          logs,
          getConfig: () => live,
          onConfigChange: (next) => {
            live = next
          },
          // A panel save re-resolves the config from disk; the keys live outside
          // that file, so reattaching the panel key here keeps the check working
          // across saves. Otherwise a save would enable panel auth with no key.
          resolveKey: async (candidate) => (await resolveKeys(candidate)).panel.key,
          authSource: keys.panel.source,
          authKeyPath: keys.panel.path,
          agentKeyPath: keys.agent.path,
          agentKeySource: keys.agent.source,
          log,
          startedAt,
          version: VERSION,
        },
        createAssets(panelDir()),
      )
    : undefined

  // The server reads its config through this accessor so a panel save takes
  // effect immediately, without a restart.
  const app = createApp({
    config: liveConfig,
    getConfig: () => live,
    catalog,
    upstream,
    log,
    ...(panel ? { panel } : {}),
    usage: { stats, recent },
  })

  await new Promise<void>((resolve, reject) => {
    app.once('error', reject)
    app.listen(config.port, config.host, () => resolve())
  })

  const address = app.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host
  const baseUrl = `http://${shown}:${port}/v1`
  const panelUrl = `http://${shown}:${port}/panel/`

  log('info', 'server listening', { url: `http://${shown}:${port}`, api: baseUrl, config: configPath })
  log('info', `OpenAI base URL: ${baseUrl}`)
  if (config.panel) log('info', `panel: ${panelUrl}`)

  // Credentials. The agent key is printed on generation (that is how it gets
  // into a client), and only summarised afterwards so a long-lived log stays
  // clean. The panel key is mentioned only when panel auth is actually on.
  if (keys.agent.source === 'disabled') {
    log('warn', 'API authentication is DISABLED — any local program can use this server')
  } else {
    if (keys.agent.source === 'generated') {
      // Plain ASCII only: Windows consoles with a legacy code page mangle
      // box-drawing characters, and this is the one message a user must be able
      // to read and copy the key out of.
      process.stderr.write(
        '\n' +
          '  ================================================================\n' +
          '   Agent key generated for this service.\n' +
          '   Send it to Agents using ' + baseUrl + '\n' +
          '  ================================================================\n\n' +
          `       ${keys.agent.key}\n\n` +
          `   Saved to: ${keys.agent.path}\n` +
          '   Reused on every later start; delete that file to rotate.\n' +
          '   Run with --no-auth to turn API authentication off.\n\n',
      )
    }
    log('info', `agent key: ${describeKey(keys.agent, 'agent')}`)
  }
  if (config.panel && keys.panel.key.length > 0) {
    log('info', `panel auth is ON — the panel asks for the key in ${keys.panel.path}`)
  } else if (config.panel) {
    log('info', 'panel auth is off — the panel opens without a key (use --panel-auth to require one)')
  }

  // Write a small runtime descriptor so tooling can discover the live port.
  const portFile = config.cachePath ? join(dirname(config.cachePath), 'server.json') : undefined
  if (portFile) {
    await mkdir(dirname(portFile), { recursive: true }).catch(() => {})
    await writeFile(
      portFile,
      JSON.stringify(
        {
          pid: process.pid,
          host: config.host,
          port,
          baseUrl,
          panelUrl: config.panel ? panelUrl : null,
          auth: keys.agent.key.length > 0,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    ).catch(() => {})
  }

  void catalogReady.then(() => {
    const snapshot = catalog.snapshot()
    if (snapshot.status === 'ready') {
      log('info', `catalog ready: ${snapshot.exposed} model(s) exposed of ${snapshot.total} live`)
      if (snapshot.exposed === 0) {
        log('warn', 'no free models exposed — try --expose-all-models, or check the upstream roster with GET /v1/models')
      }
    } else {
      log('warn', 'catalog still starting; /v1/models serves the bootstrap list until the live roster arrives')
    }
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log('info', `received ${signal}, shutting down`)
    catalog.stop()
    void stats.close()
    app.close(() => process.exit(0))
    // A hung connection must not block exit indefinitely.
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`opencodez-free failed to start: ${message}\n`)
  process.exit(1)
})
