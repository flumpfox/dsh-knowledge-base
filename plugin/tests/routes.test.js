/**
 * Integration checks for the Host half: real HTTP routes, the real kb.py engine,
 * and the Confluence mock from engine/tests.
 *
 * The page is served by the DSH Host in production, so the test reproduces that
 * shape: one `webServer.register()` call captured into a plain node:http server,
 * a fake credential store, and an optional fake schedule service.
 */
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentialKeyFor, registerSettingsUi } from '../server.js'
import { cardLocale } from '../index.js'
import { findPython } from '../../tools/lib/python.mjs'
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..')
const REPO = resolve(PLUGIN, '..')
const ENGINE = join(REPO, 'engine', 'kb.py')
const MOCK = join(REPO, 'engine', 'tests', 'mock_confluence.py')
const FIXTURE = join(REPO, 'engine', 'tests', 'make_fixture.py')

const PYTHON = process.env.KB_PYTHON || findPython()
assert.ok(PYTHON, 'Python 3 is required to run the integration tests (set KB_PYTHON)')

const TOKEN = 'test-token'
const delay = ms => new Promise(done => setTimeout(done, ms))

/** Run one test against its own registry and bases, then restore the shared one. */
async function withHome(name, run) {
  const previous = process.env.KB_DIR
  process.env.KB_DIR = join(work, name)
  mkdirSync(process.env.KB_DIR, { recursive: true })
  try {
    return await run()
  } finally {
    process.env.KB_DIR = previous
  }
}

let work
let fixture
let mock
let mockUrl
const bodies = []

/** Start the Confluence mock with extra arguments and return its base URL. */
async function startMock(extra = []) {
  const proc = spawn(PYTHON, [MOCK, '--port', '0', ...extra], { stdio: ['ignore', 'pipe', 'ignore'] })
  const first = await new Promise(done => proc.stdout.once('data', chunk => done(String(chunk))))
  return {
    url: `http://127.0.0.1:${/PORT=(\d+)/.exec(first)[1]}`,
    stop: () => proc.kill(),
  }
}

function request(url, { method = 'GET', body, headers = {} } = {}) {
  return fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async response => {
    const text = await response.text()
    bodies.push(text)
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
    return { status: response.status, text, data }
  })
}

/** The product seeds nothing; tests start with one source so legacy routes have a target. */
function seedRegistry() {
  const home = process.env.KB_DIR
  const file = join(home, 'knowledge-sources.json')
  if (existsSync(file)) return
  mkdirSync(home, { recursive: true })
  const source = {
    id: 'default', name: 'default', type: 'confluence', source: 'api', auth: 'bearer',
    baseUrl: '', filePath: '', spaces: [], spacesAll: false, root: join(home, 'default'),
    schedule: { incrementalDays: 7, fullDays: 30 }, lastSuccess: '', lastFull: '',
    lastError: '', lastRun: null, taskId: '', locale: 'en', imported: false,
  }
  writeFileSync(file, JSON.stringify({
    version: 2, defaultId: 'default', sources: [source], workspaces: {},
  }, null, 2))
}

/** Boot one plugin instance behind a real HTTP listener. */
async function boot({ withSchedule = false, records = new Map(), workspaces = null } = {}) {
  seedRegistry()
  const calls = []
  let handler = null
  const cleanups = []
  const services = {
    webServer: {
      register: route => {
        handler = route.handler
        return () => { handler = null }
      },
    },
    workspaceRegistry: workspaces || {
      list: () => [],
      resolveByPath: async () => undefined,
    },
    credentials: {
      async readRecord(key) {
        return records.get(key)
      },
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key))
        if (next === undefined) records.delete(key)
        else records.set(key, next)
        return next
      },
      async deleteRecord(key) {
        records.delete(key)
      },
    },
  }
  if (withSchedule) {
    services.schedule = {
      async create(input) {
        calls.push({ op: 'create', input })
        return { id: 'task-1', ...input }
      },
      async edit(input) {
        calls.push({ op: 'edit', input })
        return { id: input.id, active: input.patch?.active ?? true }
      },
    }
  }
  const ctx = {
    get: name => services[name],
    effect: fn => {
      const cleanup = fn()
      cleanups.push(cleanup)
      return cleanup
    },
    logger: { warn: () => {} },
  }
  registerSettingsUi(ctx)
  assert.ok(handler, 'the plugin must register its route prefix')
  const server = http.createServer((req, res) => handler(req, res))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    calls,
    records,
    call: (path, options = {}) => request(base + '/x-knowledge-base' + path, {
      ...options,
      headers: {
        ...(options.method && options.method !== 'GET' ? { origin: base } : {}),
        ...(options.headers || {}),
      },
    }),
    async close() {
      for (const cleanup of cleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
      server.closeAllConnections?.()
      await new Promise(done => server.close(done))
    },
  }
}

async function waitForJob(plugin, predicate, { path = '/job', timeoutMs = 40_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const response = await plugin.call(path)
    last = response.data
    if (predicate(last)) return last
    await delay(120)
  }
  throw new Error('the job did not settle: ' + JSON.stringify(last))
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'confluence-kb-test-'))
  process.env.KB_DIR = join(work, 'home')
  process.env.KB_ENGINE = ENGINE
  process.env.KB_PYTHON = PYTHON
  mkdirSync(process.env.KB_DIR, { recursive: true })
  fixture = join(work, 'fixture.zip')
  execFileSync(PYTHON, [FIXTURE, fixture], { stdio: 'ignore' })

  mock = await startMock(['--delay', '0.25'])
  mockUrl = mock.url
})

after(async () => {
  mock?.stop()
  if (work) rmSync(work, { recursive: true, force: true })
})

test('the plugin refuses a write that comes from another site', async () => {
  const plugin = await boot()
  try {
    const denied = await request(plugin.base + '/x-knowledge-base/config', {
      method: 'POST',
      body: { source: 'api' },
      headers: { origin: 'http://evil.example' },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.data.error, 'error.crossOrigin')
    const afterDenial = await plugin.call('/state')
    assert.equal(afterDenial.data.lastRejectedWrite.reason, 'foreign-origin')
    assert.equal(afterDenial.data.lastRejectedWrite.origin, 'http://evil.example')

    // A sandboxed document sends Origin: null; that is not this app either.
    const sandboxed = await request(plugin.base + '/x-knowledge-base/config', {
      method: 'POST',
      body: { source: 'api' },
      headers: { origin: 'null' },
    })
    assert.equal(sandboxed.status, 403)

    // DSH's own fence: no browser markers means the desktop shell or a local
    // tool, both of which are already trusted by the platform.
    const shell = await request(plugin.base + '/x-knowledge-base/config', {
      method: 'POST',
      body: { source: 'api' },
    })
    assert.equal(shell.status, 200, shell.text)

    // The loopback alias of the same listener is still this app.
    const alias = await request(plugin.base.replace('127.0.0.1', 'localhost') + '/x-knowledge-base/config', {
      method: 'POST',
      body: { source: 'api' },
      headers: { origin: plugin.base.replace('127.0.0.1', 'localhost') },
    })
    assert.equal(alias.status, 200, alias.text)
  } finally {
    await plugin.close()
  }
})

test('an empty profile reports no token and no articles', async () => {
  const plugin = await boot()
  try {
    const state = await plugin.call('/state')
    assert.equal(state.status, 200)
    assert.equal(state.data.ok, true)
    assert.equal(state.data.source, 'api')
    assert.equal(state.data.tokenConfigured, false)
    assert.equal(state.data.articleCount, 0)
    assert.equal(state.data.job.state, 'idle')
  } finally {
    await plugin.close()
  }
})

test('a credential key is always exactly two valid segments', () => {
  // The provider refuses anything else when it loads its file, and one bad key
  // takes the whole application down at startup — not just this plugin.
  const valid = /^[a-z][a-z0-9-]*$/
  for (const id of ['default', 'core', 'my-source', 'a1', '123', 'a b', 'a/b', '']) {
    const key = credentialKeyFor(id)
    const parts = key.split('/')
    assert.equal(parts.length, 2, `${key} must have two segments`)
    assert.equal(parts[0], 'knowledge-base-tools')
    assert.match(parts[1], valid, `${key} must be a valid key`)
  }
  assert.equal(credentialKeyFor('default'), 'knowledge-base-tools/default')
  assert.equal(credentialKeyFor('123'), credentialKeyFor('123'), 'the fallback is stable')
  assert.notEqual(credentialKeyFor('123'), credentialKeyFor('124'), 'the fallback is per source')
})

test('one valid credential record per source, whatever the auth kind', async () => {
  await withHome('credentials', async () => {
    const plugin = await boot()
    try {
      const saved = await plugin.call('/token', { method: 'POST', body: { token: TOKEN } })
      assert.equal(saved.status, 200)
      const keys = [...plugin.records.keys()]
      assert.equal(keys.length, 1, 'one record per source')
      assert.equal(keys[0], 'knowledge-base-tools/default')
      assert.equal(keys[0].split('/').length, 2)
      assert.equal(plugin.records.get(keys[0]).kind, 'grant')
      assert.equal(plugin.records.get(keys[0]).payload.auth, 'token')

      const basic = await plugin.call('/basic', { method: 'POST', body: { user: 'u', password: 'p' } })
      assert.equal(basic.status, 200)
      assert.equal([...plugin.records.keys()].length, 1, 'the same record is replaced')
      assert.equal(plugin.records.get(keys[0]).payload.auth, 'basic')

      const state = await plugin.call('/state')
      assert.equal(state.data.tokenConfigured, false)
      assert.equal(state.data.basicConfigured, true)
      assert.equal(state.data.basicUser, 'u')

      const cleared = await plugin.call('/basic', { method: 'POST', body: { user: '', password: '' } })
      assert.equal(cleared.status, 200)
      assert.equal(plugin.records.size, 0, 'clearing deletes the record')
    } finally {
      await plugin.close()
    }
  })
})

test('a source with an id that is not a valid key segment gets a hash slot', async () => {
  await withHome('credentials-slot', async () => {
    const plugin = await boot()
    try {
      const created = await plugin.call('/sources', { method: 'POST', body: { id: '123', name: 'Digits' } })
      assert.equal(created.status, 200)
      await plugin.call('/sources/123/token', { method: 'POST', body: { token: 'abc' } })
      const keys = [...plugin.records.keys()]
      assert.equal(keys.length, 1)
      assert.match(keys[0], /^knowledge-base-tools\/s-[0-9a-f]{16}$/)
      assert.equal(keys[0].split('/').length, 2)
    } finally {
      await plugin.close()
    }
  })
})

test('deleting a source deletes its credential', async () => {
  await withHome('credentials-delete', async () => {
    const plugin = await boot()
    try {
      const created = await plugin.call('/sources', { method: 'POST', body: { id: 'second', name: 'Second' } })
      assert.equal(created.status, 200)
      await plugin.call('/sources/second/token', { method: 'POST', body: { token: 'abc' } })
      assert.ok(plugin.records.has('knowledge-base-tools/second'))
      const deleted = await plugin.call('/sources/second/delete', { method: 'POST' })
      assert.equal(deleted.status, 200)
      assert.equal(plugin.records.has('knowledge-base-tools/second'), false)
    } finally {
      await plugin.close()
    }
  })
})

test('the token is stored in the credential store and never returned', async () => {
  const plugin = await boot()
  try {
    const saved = await plugin.call('/token', { method: 'POST', body: { token: TOKEN } })
    assert.equal(saved.status, 200)
    assert.equal(saved.data.tokenConfigured, true)
    assert.equal([...plugin.records.values()].some(record => record.payload?.token === TOKEN), true)

    const state = await plugin.call('/state')
    assert.equal(state.data.tokenConfigured, true)
    assert.ok(!state.text.includes(TOKEN), 'the state payload must not carry the token')

    const config = await plugin.call('/config', {
      method: 'POST',
      body: { source: 'api', baseUrl: mockUrl, spaces: ['DBA'], spacesAll: false, incrementalDays: 7, fullDays: 30 },
    })
    assert.equal(config.status, 200)
    assert.ok(!config.text.includes(TOKEN))
    const after = await plugin.call('/state')
    assert.ok(!after.text.includes(TOKEN))
    for (const body of bodies) {
      assert.ok(!body.includes(TOKEN), 'no response may echo the token')
    }
  } finally {
    await plugin.close()
  }
})

test('a typed token is tested as typed and a refusal is named as a refusal', async () => {
  const plugin = await boot()
  try {
    const state = await plugin.call('/state')
    assert.equal(state.data.credentialsAvailable, true)
    assert.equal(state.data.tokenConfigured, false)

    const anon = await plugin.call('/test', { method: 'POST', body: { source: 'api', baseUrl: mockUrl } })
    assert.equal(anon.status, 400)
    assert.equal(anon.data.error, 'error.tokenMissing')

    const typed = await plugin.call('/test', {
      method: 'POST', body: { source: 'api', baseUrl: mockUrl, token: TOKEN },
    })
    assert.equal(typed.status, 200)
    assert.equal(typed.data.spaces.length, 2)

    const wrong = await plugin.call('/test', {
      method: 'POST', body: { source: 'api', baseUrl: mockUrl, token: 'not-the-token' },
    })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.data.error, 'error.connection.denied')
  } finally {
    await plugin.close()
  }
})

test('basic auth signs in with a user and password', async () => {
  const basic = await startMock(['--user', 'tester', '--password', 's3cret'])
  // Its own knowledge base: this test imports, and the other API tests must not
  // see those pages as already present.
  const previousHome = process.env.KB_DIR
  process.env.KB_DIR = join(work, 'basic')
  mkdirSync(process.env.KB_DIR, { recursive: true })
  const plugin = await boot()
  try {
    const missing = await plugin.call('/test', {
      method: 'POST', body: { source: 'api', auth: 'basic', baseUrl: basic.url },
    })
    assert.equal(missing.status, 400)
    assert.equal(missing.data.error, 'error.basicMissing')

    const typed = await plugin.call('/test', {
      method: 'POST',
      body: { source: 'api', auth: 'basic', baseUrl: basic.url, user: 'tester', password: 's3cret' },
    })
    assert.equal(typed.status, 200, JSON.stringify(typed.data))
    assert.equal(typed.data.spaces.length, 2)
    assert.equal(typed.data.identity.username, 'tester')

    const saved = await plugin.call('/basic', {
      method: 'POST', body: { user: 'tester', password: 's3cret' },
    })
    assert.equal(saved.data.basicConfigured, true)
    assert.equal(saved.data.basicUser, 'tester')

    const state = await plugin.call('/state')
    assert.equal(state.data.basicConfigured, true)
    assert.equal(state.data.basicUser, 'tester')
    assert.ok(!state.text.includes('s3cret'), 'the password must not travel back')

    await plugin.call('/config', {
      method: 'POST',
      body: { source: 'api', auth: 'basic', baseUrl: basic.url, spacesAll: true },
    })
    const spaces = await plugin.call('/spaces')
    assert.equal(spaces.status, 200)
    assert.equal(spaces.data.spaces.length, 2)

    // The import must reach kb.py with Basic credentials in the right place:
    // `--user` belongs to `fetch`, not to the top-level parser.
    const started = await plugin.call('/import', { method: 'POST', body: { full: true, locale: 'en' } })
    assert.equal(started.status, 200, JSON.stringify(started.data))
    const job = await waitForJob(plugin,
      value => value.state !== 'running' && value.task && value.task.state !== 'pending')
    assert.equal(job.state, 'done', `${JSON.stringify(job.error)} :: ${job.lines.join(' | ')}`)
    assert.equal(job.stats.added, 3)
  } finally {
    await plugin.close()
    basic.stop()
    process.env.KB_DIR = previousHome
  }
})

test('a server that ignores the credentials is reported as anonymous, not as zero spaces', async () => {
  // Confluence Server 8.5 ignores "Authorization: Bearer" and answers 200 with an
  // empty space list; that must surface as a stated authentication failure.
  const ignoring = await startMock(['--ignore-authorization'])
  const plugin = await boot()
  try {
    await plugin.call('/token', { method: 'POST', body: { token: 'ignored-token' } })
    await plugin.call('/config', {
      method: 'POST',
      body: { source: 'api', auth: 'bearer', baseUrl: ignoring.url, spacesAll: true },
    })

    const tested = await plugin.call('/test', {
      method: 'POST', body: { source: 'api', auth: 'bearer', baseUrl: ignoring.url, token: 'ignored-token' },
    })
    assert.notEqual(tested.status, 200)
    assert.equal(tested.data.error, 'error.authRejected')

    const imported = await plugin.call('/import', { method: 'POST', body: { full: true } })
    assert.equal(imported.status, 400)
    assert.equal(imported.data.error, 'error.authRejected')
    const job = await plugin.call('/job')
    assert.notEqual(job.data.state, 'running', 'a refused import must not start')
  } finally {
    await plugin.close()
    ignoring.stop()
  }
})

test('the API source lists spaces and the file source is validated', async () => {
  const plugin = await boot()
  try {
    await plugin.call('/token', { method: 'POST', body: { token: TOKEN } })
    await plugin.call('/config', {
      method: 'POST',
      body: { source: 'api', baseUrl: mockUrl, spacesAll: true, incrementalDays: 7, fullDays: 30 },
    })

    const checked = await plugin.call('/test', { method: 'POST', body: { source: 'api', baseUrl: mockUrl } })
    assert.equal(checked.status, 200)
    assert.deepEqual(checked.data.spaces.map(space => space.key).sort(), ['DBA', 'OPS'])

    const spaces = await plugin.call('/spaces')
    assert.equal(spaces.status, 200)
    assert.equal(spaces.data.spaces.length, 2)

    const file = await plugin.call('/test', { method: 'POST', body: { source: 'file', filePath: fixture } })
    assert.equal(file.status, 200)
    assert.equal(file.data.pages, 3)
    assert.ok(file.data.bytes > 0)

    const bogus = await plugin.call('/test', {
      method: 'POST', body: { source: 'file', filePath: join(work, 'absent.zip') },
    })
    assert.equal(bogus.status, 400)
    assert.equal(bogus.data.error, 'error.fileMissing')
  } finally {
    await plugin.close()
  }
})

test('a file import reports progress, stats, and the Automation task record', async () => {
  const plugin = await boot({ withSchedule: true })
  try {
    await plugin.call('/config', {
      method: 'POST',
      body: { source: 'file', filePath: fixture, spacesAll: true, locale: 'en' },
    })
    const started = await plugin.call('/import', { method: 'POST', body: { full: true, locale: 'en' } })
    assert.equal(started.status, 200)
    assert.equal(started.data.job.state, 'running')

    const job = await waitForJob(plugin, value => value.state !== 'running' && value.task && value.task.state !== 'pending')
    assert.equal(job.state, 'done', JSON.stringify(job.error))
    assert.equal(job.stats.added, 3)
    assert.equal(job.progress.total, 3)
    assert.equal(job.progress.done, 3)
    assert.ok(job.durationMs >= 0)
    assert.equal(job.task.state, 'created')

    const create = plugin.calls.find(call => call.op === 'create')
    assert.ok(create, 'the report must create an Automation task')
    assert.match(create.input.title, /import report/)
    assert.match(create.input.prompt, /Added: 3/)
    assert.match(create.input.prompt, /Source: Export file/)
    assert.match(create.input.prompt, /Mode: full/)
    // The Host validates the local time shape, so pin it: an HH:mm value is rejected
    // with "Local at requires date YYYY-MM-DD and time HH:mm:ss".
    assert.equal(create.input.timing.kind, 'at')
    assert.equal(create.input.timing.at.date, '2099-12-31')
    assert.match(create.input.timing.at.time, /^\d{2}:\d{2}:\d{2}$/)
    assert.equal(typeof create.input.timing.at.time_zone, 'string')
    const pause = plugin.calls.find(call => call.op === 'edit')
    assert.equal(pause.input.patch.active, false, 'the record must never fire')

    const state = await plugin.call('/state')
    assert.equal(state.data.taskId, 'task-1')
    assert.equal(state.data.lastRun.state, 'done')
    assert.equal(state.data.lastRun.stats.added, 3)
    assert.ok(state.data.articleCount > 0)
    assert.ok(existsSync(join(process.env.KB_DIR, 'default', 'kb.sqlite')))
  } finally {
    await plugin.close()
  }
})

test('without a schedule service the report is reported as missing', async () => {
  const plugin = await boot()
  try {
    await plugin.call('/config', {
      method: 'POST',
      body: { source: 'file', filePath: fixture, spacesAll: true, locale: 'en' },
    })
    await plugin.call('/import', { method: 'POST', body: { full: true, locale: 'en' } })
    const job = await waitForJob(plugin, value => value.state !== 'running' && value.task && value.task.state !== 'pending')
    assert.equal(job.state, 'done')
    assert.equal(job.task.state, 'unavailable')
    assert.equal(job.task.code, 'task.unavailable')
  } finally {
    await plugin.close()
  }
})

test('an API import reports progress per space', async () => {
  const plugin = await boot()
  try {
    await plugin.call('/token', { method: 'POST', body: { token: TOKEN } })
    await plugin.call('/config', {
      method: 'POST',
      body: { source: 'api', baseUrl: mockUrl, spacesAll: true, locale: 'ru' },
    })
    const started = await plugin.call('/import', { method: 'POST', body: { full: true, locale: 'ru' } })
    assert.equal(started.status, 200, started.text)
    const job = await waitForJob(plugin,
      value => value.state !== 'running' && value.task && value.task.state !== 'pending')
    assert.equal(job.state, 'done', `${JSON.stringify(job.error)} :: ${job.lines.join(' | ')}`)
    assert.equal(job.progress.total, 4, 'DBA has three pages and OPS one')
    assert.equal(job.progress.done, 4)
    assert.match(job.progress.space, /^(DBA|OPS)$/)
    assert.equal(job.stats.added, 3, 'the empty page is skipped by the engine')
  } finally {
    await plugin.close()
  }
})

test('an import can be stopped, and a second one cannot start', async () => {
  const plugin = await boot()
  try {
    await plugin.call('/token', { method: 'POST', body: { token: TOKEN } })
    await plugin.call('/config', {
      method: 'POST',
      body: { source: 'api', baseUrl: mockUrl, spacesAll: true, locale: 'en' },
    })
    await plugin.call('/import', { method: 'POST', body: { full: true, locale: 'en' } })
    const second = await plugin.call('/import', { method: 'POST', body: { full: true, locale: 'en' } })
    assert.equal(second.status, 400)
    assert.equal(second.data.error, 'import.busy')

    const stopped = await plugin.call('/cancel', { method: 'POST', body: {} })
    assert.equal(stopped.status, 200)
    const job = await waitForJob(plugin, value => value.state !== 'running' && value.task && value.task.state !== 'pending')
    assert.equal(job.state, 'cancelled')
    assert.equal(job.error.code, 'error.cancelled')
  } finally {
    await plugin.close()
  }
})

test('the page can read the dictionaries and nothing outside them', async () => {
  const plugin = await boot()
  try {
    const english = await plugin.call('/locale/en.json')
    assert.equal(english.status, 200)
    const dictionary = JSON.parse(english.text)
    assert.equal(typeof dictionary['nav.label'], 'string')
    assert.equal(typeof dictionary['section.title'], 'string')
    assert.equal(typeof dictionary.meta.title, 'string')

    const russian = await plugin.call('/locale/ru.json')
    assert.equal(russian.status, 200)
    const ru = JSON.parse(russian.text)
    const missing = Object.keys(dictionary).filter(key => key !== 'meta' && typeof ru[key] !== 'string')
    assert.deepEqual(missing, [], 'both languages must carry the same keys')
    assert.equal(ru.meta.detail, 'docs/DETAIL.ru.md')

    const traveller = await plugin.call('/locale/../../package.json')
    assert.equal(traveller.status, 404)
  } finally {
    await plugin.close()
  }
})

test('the saved token survives a reload and can be deleted', async () => {
  const records = new Map()
  const plugin = await boot({ records })
  try {
    await plugin.call('/token', { method: 'POST', body: { token: TOKEN } })
  } finally {
    await plugin.close()
  }
  const again = await boot({ records })
  try {
    const state = await again.call('/state')
    assert.equal(state.data.tokenConfigured, true)
    const cleared = await again.call('/token', { method: 'POST', body: { token: '' } })
    assert.equal(cleared.data.tokenConfigured, false)
    const after = await again.call('/state')
    assert.equal(after.data.tokenConfigured, false)
  } finally {
    await again.close()
  }
})

test('a second source gets its own base and never touches the first', async () => {
  await withHome('multi', async () => {
    const plugin = await boot()
    try {
      // The default source imports the fixture into its own base.
      await plugin.call('/config', {
        method: 'POST',
        body: { source: 'file', filePath: fixture, spacesAll: true, name: 'First' },
      })
      await plugin.call('/import', { method: 'POST', body: { full: true, locale: 'en' } })
      const firstJob = await waitForJob(plugin,
        value => value.state !== 'running' && value.task && value.task.state !== 'pending')
      assert.equal(firstJob.state, 'done', firstJob.lines.join(' | '))
      const firstManifest = join(process.env.KB_DIR, 'default', 'MANIFEST.jsonl')
      const firstBytes = readFileSync(firstManifest)
      assert.equal(firstBytes.toString().trim().split('\n').length, 3)

      // A second source points at the same archive: its own base, its own pages.
      const created = await plugin.call('/sources', { method: 'POST', body: { name: 'Second' } })
      assert.equal(created.status, 200)
      const secondId = created.data.id
      assert.equal(secondId, 'second')
      const saved = await plugin.call(`/sources/${secondId}`, {
        method: 'POST',
        body: {
          name: 'Second', source: 'file', filePath: fixture, spacesAll: true,
          incrementalDays: 7, fullDays: 30, locale: 'en',
        },
      })
      assert.equal(saved.status, 200, saved.text)
      const secondRoot = saved.data.source.root
      assert.notEqual(secondRoot, join(process.env.KB_DIR, 'default'), 'each source owns a separate base')
      assert.equal(saved.data.source.isDefault, false)

      const started = await plugin.call(`/sources/${secondId}/import`, {
        method: 'POST', body: { full: true, locale: 'en' },
      })
      assert.equal(started.status, 200, started.text)
      const secondJob = await waitForJob(plugin,
        value => value.state !== 'running' && value.task && value.task.state !== 'pending',
        { path: `/sources/${secondId}/job` })
      assert.equal(secondJob.state, 'done', secondJob.lines.join(' | '))
      assert.equal(secondJob.stats.added, 3)
      assert.ok(existsSync(join(secondRoot, 'kb.sqlite')))
      assert.ok(existsSync(join(secondRoot, 'MANIFEST.jsonl')))

      // The first base is byte-identical: another source's import never touches it.
      assert.deepEqual(readFileSync(firstManifest), firstBytes,
        'an import of another source must not rewrite this base')

      const list = await plugin.call('/sources')
      assert.equal(list.data.sources.length, 2)
      assert.deepEqual(list.data.sources.map(row => row.name).sort(), ['First', 'Second'])
      assert.equal(list.data.sources.find(row => row.id === secondId).articleCount, 3)
      assert.equal(list.data.sources.find(row => row.isDefault).name, 'First')
    } finally {
      await plugin.close()
    }
  })
})

test('the default source and per-workspace sets are stored', async () => {
  const workspaces = [
    { id: 'ws-docs', title: 'Documentation', path: 'C:\\work\\docs' },
    { id: 'ws-ops', title: 'Operations', path: 'C:\\work\\ops' },
  ]
  await withHome('workspaces', async () => {
    const plugin = await boot({
      workspaces: {
        list: () => workspaces,
        resolveByPath: async path => workspaces.find(row => row.path === path),
      },
    })
    try {
      const created = await plugin.call('/sources', { method: 'POST', body: { name: 'Second' } })
      const secondId = created.data.id
      const first = (await plugin.call('/sources')).data.sources.find(row => row.isDefault)

      const made = await plugin.call('/default', { method: 'POST', body: { id: secondId } })
      assert.equal(made.status, 200)
      assert.equal(made.data.defaultId, secondId)

      const bound = await plugin.call('/workspaces', {
        method: 'POST',
        body: { workspaceId: 'ws-docs', sources: [first.id, secondId] },
      })
      assert.equal(bound.status, 200, bound.text)
      await plugin.call('/workspaces', {
        method: 'POST',
        body: { workspaceId: 'ws-ops', sources: [secondId] },
      })
      const listed = await plugin.call('/sources')
      const docs = listed.data.workspaces.find(row => row.id === 'ws-docs')
      const ops = listed.data.workspaces.find(row => row.id === 'ws-ops')
      assert.deepEqual(docs.sources, [first.id, secondId])
      assert.deepEqual(ops.sources, [secondId])
      assert.equal(listed.data.defaultId, secondId)

      // Clearing a set leaves the workspace on the default source.
      await plugin.call('/workspaces', { method: 'POST', body: { workspaceId: 'ws-ops', sources: [] } })
      const cleared = await plugin.call('/sources')
      assert.deepEqual(cleared.data.workspaces.find(row => row.id === 'ws-ops').sources, [])
    } finally {
      await plugin.close()
    }
  })
})

test('the last source can be deleted, and deletion removes its base', async () => {
  await withHome('deletion', async () => {
    const plugin = await boot()
    try {
      const listed = await plugin.call('/sources')
      const only = listed.data.sources[0]
      // A file in the base proves deletion removes the files, not just the row.
      mkdirSync(join(only.root, 'dba'), { recursive: true })
      writeFileSync(join(only.root, 'dba', 'kept--1.md'), '# stale article\n', 'utf8')

      const created = await plugin.call('/sources', { method: 'POST', body: { name: 'Spare' } })
      const spareId = created.data.id
      const removed = await plugin.call(`/sources/${spareId}/delete`, { method: 'POST', body: {} })
      assert.equal(removed.status, 200)
      const after = await plugin.call('/sources')
      assert.deepEqual(after.data.sources.map(row => row.id), [only.id])
      const missing = await plugin.call(`/sources/${spareId}/state`)
      assert.equal(missing.status, 404)
      assert.equal(missing.data.error, 'error.sourceMissing')

      // The only source goes too, and takes its base with it.
      const last = await plugin.call(`/sources/${only.id}/delete`, { method: 'POST', body: {} })
      assert.equal(last.status, 200)
      assert.equal(existsSync(join(only.root, 'dba', 'kept--1.md')), false)
      const empty = await plugin.call('/sources')
      assert.deepEqual(empty.data.sources, [])
      assert.equal(empty.data.defaultId, '')
      // An empty registry stays empty: it is a real state, not a missing file.
      const again = await plugin.call('/sources')
      assert.deepEqual(again.data.sources, [])
      const legacy = await plugin.call('/state')
      assert.equal(legacy.status, 409)
      assert.equal(legacy.data.error, 'error.noSources')
    } finally {
      await plugin.close()
    }
  })
})

test('deleting the base files keeps the source and unlocks the base URL', async () => {
  await withHome('clear', async () => {
    const plugin = await boot()
    try {
      const created = await plugin.call('/sources', {
        method: 'POST',
        body: { name: 'Clear me', source: 'api', baseUrl: 'http://kb.example.local' },
      })
      const id = created.data.id
      const root = created.data.source.root
      mkdirSync(join(root, 'dba'), { recursive: true })
      writeFileSync(join(root, 'dba', 'gone--7.md'), '# article\n', 'utf8')
      const saved = await plugin.call(`/sources/${id}/token`, { method: 'POST', body: { token: TOKEN } })
      assert.equal(saved.status, 200)

      const cleared = await plugin.call(`/sources/${id}/clear`, { method: 'POST', body: {} })
      assert.equal(cleared.status, 200)
      assert.equal(cleared.data.source.articleCount, 0)
      assert.equal(existsSync(join(root, 'dba', 'gone--7.md')), false)
      // The connection settings and the credentials survive; the data does not.
      assert.equal(cleared.data.source.baseUrl, 'http://kb.example.local')
      assert.equal(cleared.data.source.tokenConfigured, true)
      // The URL was never locked by a successful import, so it stays editable.
      assert.equal(cleared.data.source.urlLocked, false)
      const renamed = await plugin.call(`/sources/${id}`, {
        method: 'POST',
        body: { baseUrl: 'http://kb2.example.local' },
      })
      assert.equal(renamed.status, 200)
      assert.equal(renamed.data.source.baseUrl, 'http://kb2.example.local')
    } finally {
      await plugin.close()
    }
  })
})

test('the export dialog refuses a bad name, a missing folder and an existing file', async () => {
  await withHome('export-validation', async () => {
    const plugin = await boot()
    try {
      const created = await plugin.call('/sources', {
        method: 'POST',
        body: { name: 'Export me', source: 'api', baseUrl: 'http://kb.example.local' },
      })
      const id = created.data.id
      mkdirSync(join(created.data.source.root, 'dba'), { recursive: true })
      writeFileSync(join(created.data.source.root, 'dba', 'one--1.md'), '# one\n', 'utf8')

      const noName = await plugin.call(`/sources/${id}/export`, {
        method: 'POST', body: { directory: work, fileName: '' },
      })
      assert.equal(noName.status, 400)
      assert.equal(noName.data.error, 'error.exportName')

      const badName = await plugin.call(`/sources/${id}/export`, {
        method: 'POST', body: { directory: work, fileName: 'a/b.zip' },
      })
      assert.equal(badName.data.error, 'error.exportName')

      const noDir = await plugin.call(`/sources/${id}/export`, {
        method: 'POST', body: { directory: join(work, 'does-not-exist'), fileName: 'x.zip' },
      })
      assert.equal(noDir.data.error, 'error.exportDirectory')

      writeFileSync(join(work, 'exists.zip'), 'x', 'utf8')
      const clash = await plugin.call(`/sources/${id}/export`, {
        method: 'POST', body: { directory: work, fileName: 'exists.zip' },
      })
      assert.equal(clash.data.error, 'error.exportExists')

      // Revealing is only ever the finished export's own path, never a client path.
      // Checked while the source has no finished export, before the overwrite run.
      const noExport = await plugin.call(`/sources/${id}/export/reveal`, { method: 'POST', body: {} })
      assert.equal(noExport.status, 400)
      assert.equal(noExport.data.error, 'error.revealMissing')

      // The page asks; answering "Replace" allows the overwrite.
      const replaced = await plugin.call(`/sources/${id}/export`, {
        method: 'POST', body: { directory: work, fileName: 'exists.zip', overwrite: true },
      })
      assert.equal(replaced.status, 200, replaced.text)
      const replacedJob = await waitForJob(plugin,
        job => job.state === 'done' || job.state === 'error',
        { path: `/sources/${id}/export/job`, timeoutMs: 60_000 })
      assert.equal(replacedJob.state, 'done', JSON.stringify(replacedJob.error))
      assert.ok(readFileSync(join(work, 'exists.zip')).length > 10, 'a real archive replaced the file')
      const replacedCheck = execFileSync(PYTHON,
        [ENGINE, 'unpack', '--archive', join(work, 'exists.zip'), '--check', '--json'],
        { encoding: 'utf8' }).trim().split('\n').pop()
      assert.equal(JSON.parse(replacedCheck).ok, true)

      // Without the Host picker the page still works: it falls back to the field.
      const noPicker = await plugin.call('/pick-folder', { method: 'POST', body: {} })
      assert.equal(noPicker.status, 400)
      assert.equal(noPicker.data.error, 'error.noPicker')
    } finally {
      await plugin.close()
    }
  })
})

test('a base exported here imports elsewhere and stays bound to its URL', async () => {
  await withHome('archive-one', async () => {
    const source = await boot()
    const exportPath = join(work, 'archive-one.zip')
    try {
      const created = await source.call('/sources', {
        method: 'POST',
        body: { name: 'Archive me', source: 'api', baseUrl: mockUrl, spacesAll: true },
      })
      const id = created.data.id
      await source.call(`/sources/${id}/token`, { method: 'POST', body: { token: TOKEN } })
      const started = await source.call(`/sources/${id}/import`, { method: 'POST', body: { full: true } })
      assert.equal(started.status, 200)
      const done = await waitForJob(source, job => job.state === 'done', {
        path: `/sources/${id}/job`, timeoutMs: 60_000,
      })
      assert.ok(done.stats, 'the import must produce stats')

      const plan = await source.call(`/sources/${id}/export`)
      assert.equal(plan.status, 200, plan.text)
      assert.equal(plan.data.ok, true)
      assert.match(plan.data.fileName, /\.zip$/)
      assert.equal(typeof plan.data.directory, 'string')

      const startedExport = await source.call(`/sources/${id}/export`, {
        method: 'POST', body: { directory: work, fileName: 'archive-one.zip' },
      })
      assert.equal(startedExport.status, 200, startedExport.text)
      assert.equal(startedExport.data.job.state, 'running')
      const packed = await waitForJob(source,
        job => job.state === 'done' || job.state === 'error',
        { path: `/sources/${id}/export/job`, timeoutMs: 60_000 })
      assert.equal(packed.state, 'done', JSON.stringify(packed.error))
      assert.equal(packed.path, exportPath)
      assert.equal(existsSync(exportPath), true)
      assert.equal(packed.articles > 0, true)

      // The archive names its origin but carries no secret.
      const checked = execFileSync(PYTHON, [ENGINE, 'unpack', '--archive', exportPath, '--check', '--json'],
        { encoding: 'utf8' }).trim().split('\n').pop()
      const meta = JSON.parse(checked)
      assert.equal(meta.ok, true)
      assert.equal(meta.source.baseUrl, mockUrl)
      assert.equal(meta.articles > 0, true)
      for (const secret of [TOKEN, 'password', 'token']) {
        assert.equal(JSON.stringify(meta.source).includes(secret), false, `metadata leaked ${secret}`)
      }
    } finally {
      await source.close()
    }

    // A fresh home, as if on another machine.
    const previous = process.env.KB_DIR
    process.env.KB_DIR = join(work, 'archive-two')
    mkdirSync(process.env.KB_DIR, { recursive: true })
    const target = await boot()
    try {
      const imported = await target.call('/import-base', {
        method: 'POST', body: { filePath: exportPath },
      })
      assert.equal(imported.status, 200, imported.text)
      const fresh = imported.data
      assert.equal(fresh.source.baseUrl, mockUrl)
      assert.equal(fresh.source.imported, true)
      assert.equal(fresh.source.urlLocked, true)
      assert.equal(fresh.articles > 0, true)
      assert.equal(existsSync(fresh.source.root), true)

      // The URL is frozen: another server needs a new source.
      const repointed = await target.call(`/sources/${fresh.id}`, {
        method: 'POST', body: { baseUrl: 'http://other.example.local' },
      })
      assert.equal(repointed.status, 400)
      assert.equal(repointed.data.error, 'error.baseUrlLocked')
      const same = await target.call(`/sources/${fresh.id}`, {
        method: 'POST', body: { baseUrl: mockUrl, name: 'Renamed' },
      })
      assert.equal(same.status, 200)
      assert.equal(same.data.source.name, 'Renamed')

      // Updating is still possible: different credentials, same server.
      await target.call(`/sources/${fresh.id}/token`, { method: 'POST', body: { token: TOKEN } })
      const started = await target.call(`/sources/${fresh.id}/import`, {
        method: 'POST', body: { full: true },
      })
      assert.equal(started.status, 200, started.text)
      const done = await waitForJob(target, job => job.state === 'done', {
        path: `/sources/${fresh.id}/job`, timeoutMs: 60_000,
      })
      assert.ok(done.stats, 'the imported base must still update from Confluence')
    } finally {
      await target.close()
      process.env.KB_DIR = previous
    }
  })
})

test('every locale key the page asks for exists in both dictionaries', () => {
  const english = JSON.parse(readFileSync(join(PLUGIN, 'locale', 'en.json'), 'utf8'))
  const russian = JSON.parse(readFileSync(join(PLUGIN, 'locale', 'ru.json'), 'utf8'))
  const source = readFileSync(join(PLUGIN, 'client.js'), 'utf8')
  const staticKeys = new Set()
  // t('literal') is the only way the page names copy; template/free-form calls are dynamic.
  for (const match of source.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) staticKeys.add(match[1])
  // Families the page builds at render time.
  for (const key of [
    'source.api', 'source.file', 'mode.incremental', 'mode.full',
    'state.idle', 'state.running', 'state.done', 'state.error', 'state.cancelled',
    'error.connection.denied', 'error.connection.http', 'error.internal', 'error.noSpaces',
    'error.url.empty', 'error.tokenMissing', 'error.filePathMissing',
    'task.failed', 'task.rejected', 'task.pauseRejected', 'task.unavailable',
  ]) staticKeys.add(key)
  const missing = [...staticKeys].filter(key =>
    typeof english[key] !== 'string' || typeof russian[key] !== 'string')
  assert.deepEqual(missing, [], `missing locale keys: ${missing.join(', ')}`)
  assert.ok(staticKeys.size > 40, `expected the page to name many keys, found ${staticKeys.size}`)
})

test('every locale key the Host emits exists in both dictionaries', () => {
  const english = JSON.parse(readFileSync(join(PLUGIN, 'locale', 'en.json'), 'utf8'))
  const russian = JSON.parse(readFileSync(join(PLUGIN, 'locale', 'ru.json'), 'utf8'))
  // The Host formats its own copy (the Automation task title and report) and
  // returns error codes instead of prose; every one of those names a key here.
  const hostKeys = [
    'error.crossOrigin', 'error.internal', 'error.notFound', 'error.credentials',
    'error.tokenMissing', 'error.noSpaces', 'error.filePathMissing', 'error.fileMissing',
    'error.fileEmpty', 'error.fileNotZip', 'error.fileNoPages', 'error.fileUnreadable',
    'error.url.empty', 'error.url.invalid', 'error.url.scheme', 'error.connection',
    'error.connection.denied', 'error.connection.http', 'error.exit', 'error.spawn',
    'error.cancelled', 'error.stateWrite', 'import.busy', 'import.notRunning',
    'task.title', 'task.unavailable', 'task.rejected', 'task.failed', 'task.pauseRejected',
    'task.card.heading', 'task.card.source', 'task.card.target', 'task.card.mode',
    'task.card.started', 'task.card.duration', 'task.card.added', 'task.card.changed',
    'task.card.deprecated', 'task.card.skipped', 'task.card.result', 'task.card.error',
    'task.card.purpose',
    'task.result.success', 'task.result.failed', 'task.result.cancelled',
    'tool.search.title', 'tool.read.title', 'tool.review.title', 'tool.status.title',
    'duration.seconds', 'duration.minutes', 'source.api', 'source.file',
    'mode.incremental', 'mode.full',
  ]
  const missing = hostKeys.filter(key => typeof english[key] !== 'string' || typeof russian[key] !== 'string')
  assert.deepEqual(missing, [], `locale files are missing: ${missing.join(', ')}`)

  const englishKeys = Object.keys(english).filter(key => key !== 'meta').sort()
  const russianKeys = Object.keys(russian).filter(key => key !== 'meta').sort()
  assert.deepEqual(russianKeys, englishKeys, 'both locales must carry the same keys')
})

test('a tool card speaks the language of the source it targets', () => {
  const registry = {
    defaultId: 'primary',
    sources: [
      { id: 'primary', locale: 'ru' },
      { id: 'secondary', locale: 'en' },
      { id: 'plain', locale: '' },
    ],
  }
  assert.equal(cardLocale({}, registry), 'ru')
  assert.equal(cardLocale({ source: 'secondary' }, registry), 'en')
  // An unknown id falls back to the default source, and an unknown language to English.
  assert.equal(cardLocale({ source: 'gone' }, registry), 'ru')
  assert.equal(cardLocale({}, { defaultId: 'plain', sources: registry.sources }), 'en')
})
