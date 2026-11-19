/**
 * Host half of the Confluence knowledge base settings page.
 *
 * Several sources can be configured, each with its own knowledge base, its own
 * schedule and its own import job: one wiki never writes into another's base, so
 * an import can only ever tombstone pages of its own source. One source is the
 * default; a workspace may instead bind an ordered set of sources.
 *
 * Two data-source kinds drive the same engine:
 *   api  — a Confluence URL plus either a Personal Access Token (`Bearer`, Data
 *          Center) or a user and password (`Basic`, every Server);
 *   file — an HTML export zip on disk, imported with no credentials at all.
 *
 * `kb.py --progress` prints `PROGRESS <done>/<total> <space>` on stderr; those
 * lines feed `GET …/job`, which the page polls while an import runs.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ProgressState, clampInt, dueMode, elapsedMs, interpolate, normalizeBaseUrl,
  parseImportSummary, parseInspect, validateBaseUrl,
} from './lib/core.js'
import {
  blankSource, normalizeRegistry, normalizeSource, slugify, sourceIdsFor, uniqueId, urlLockedFor,
} from './lib/registry.js'

const PREFIX = '/x-knowledge-base'
const JOB_LINES = 200
const LANGUAGES = new Set(['en', 'ru'])
const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))

// ---------------------------------------------------------------------------
// paths and the source registry
// ---------------------------------------------------------------------------

/** Home of every base and of the registry: `KB_DIR` or `~/.dsh/kb`. */
function kbHome() {
  return process.env.KB_DIR || join(homedir(), '.dsh', 'kb')
}

/** One registry file next to the sources it describes. */
function registryFile() {
  return join(kbHome(), 'knowledge-sources.json')
}

function legacyStateFile() {
  return join(kbHome(), 'connection.json')
}

/**
 * The resolved base directory of a source, but only when it really lives under
 * the knowledge-base directory. The registry is a plain file a person can edit,
 * and a wrong value must never turn "delete this base" into "delete C:\\".
 */
function baseInsideKb(root) {
  if (!root) return ''
  const base = resolve(kbHome())
  const target = resolve(root)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return ''
  return target
}

function loadRegistry() {
  let stored = null
  let legacy = null
  try {
    stored = JSON.parse(readFileSync(registryFile(), 'utf8'))
  } catch {
    stored = null
  }
  if (!stored) {
    try {
      legacy = JSON.parse(readFileSync(legacyStateFile(), 'utf8'))
    } catch {
      legacy = null
    }
  }
  const registry = normalizeRegistry(stored, { home: kbHome(), legacyV1: legacy })
  for (const source of registry.sources) {
    if (!source.root) source.root = join(kbHome(), source.id)
  }
  return registry
}

function saveRegistry(registry) {
  const file = registryFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return registry
}

function sourceById(registry, id) {
  return registry.sources.find(source => source.id === id)
}

function defaultSource(registry) {
  return sourceById(registry, registry.defaultId) || registry.sources[0]
}

/** Apply a patch to one source and persist the whole registry. */
function patchSource(registry, id, patch) {
  const index = registry.sources.findIndex(source => source.id === id)
  if (index < 0) return null
  registry.sources[index] = normalizeSource({ ...registry.sources[index], ...patch, id }, id)
  saveRegistry(registry)
  return registry.sources[index]
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

/**
 * The plugin's registered name in the plugin tree, used as the credentials scope.
 *
 * The credential provider insists on exactly `<scope>/<id>`: both segments are
 * lowercase hyphenated identifiers and nothing else. A key with a third segment
 * (`…/<id>/basic`) is rejected when the provider loads its file, which takes the
 * whole application down at startup — not just this plugin.
 */
const CREDENTIAL_SCOPE = 'knowledge-base-tools'
const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/

/**
 * The credentials key for one source: one record per source, never per auth kind.
 *
 * A registry id is normally a valid segment, but `slugify` can produce one that
 * starts with a digit; such an id is replaced by a stable hash slot so the key
 * stays valid without ever colliding with another source's slot.
 */
export function credentialKeyFor(sourceId) {
  const id = String(sourceId ?? '')
  const slot = KEY_SEGMENT.test(id)
    ? id
    : `s-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`
  return `${CREDENTIAL_SCOPE}/${slot}`
}

/** The stored grant for one source, or undefined when nothing is saved. */
async function readCredential(ctx, source) {
  const credentials = ctx.get('credentials')
  if (!credentials) return undefined
  try {
    return await credentials.readRecord(credentialKeyFor(source.id))
  } catch {
    return undefined
  }
}

async function resolveAuth(ctx, source) {
  const credentials = ctx.get('credentials')
  if (!credentials) return { kind: source.auth, configured: false, code: 'error.credentials' }
  const stored = await readCredential(ctx, source)
  const payload = stored?.kind === 'grant' ? stored.payload : undefined
  if (source.auth === 'basic') {
    const user = payload?.auth === 'basic' ? payload.user || '' : ''
    const password = payload?.auth === 'basic' ? payload.password || '' : ''
    return { kind: 'basic', user, password, configured: Boolean(user && password), code: 'error.basicMissing' }
  }
  const token = payload?.auth === 'token' ? payload.token || '' : ''
  return { kind: 'bearer', token, configured: Boolean(token), code: 'error.tokenMissing' }
}

// ---------------------------------------------------------------------------
// locale dictionaries (the plugin's own locale/*.json, shared with the browser)
// ---------------------------------------------------------------------------

const dictCache = new Map()

function loadDictionary(language) {
  const lang = LANGUAGES.has(language) ? language : 'en'
  if (dictCache.has(lang)) return dictCache.get(lang)
  let dict = {}
  try {
    const raw = JSON.parse(readFileSync(join(PLUGIN_DIR, 'locale', `${lang}.json`), 'utf8'))
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') dict[key] = value
    }
  } catch {
    dict = {}
  }
  dictCache.set(lang, dict)
  return dict
}

export function translator(language) {
  const primary = loadDictionary(language)
  const fallback = loadDictionary('en')
  return (key, params) => interpolate(primary[key] ?? fallback[key] ?? key, params)
}

// ---------------------------------------------------------------------------
// Confluence REST
// ---------------------------------------------------------------------------

function authHeaders(auth) {
  const headers = { accept: 'application/json', 'user-agent': 'dsh-knowledge-base/1.0' }
  if (auth?.token) {
    headers.authorization = 'Bearer ' + auth.token
  } else if (auth?.user) {
    const pair = Buffer.from(`${auth.user}:${auth.password ?? ''}`, 'utf8').toString('base64')
    headers.authorization = 'Basic ' + pair
  }
  return headers
}

/**
 * Who the server thinks we are. Confluence answers `type: 'anonymous'` when it
 * ignored the credentials, which is the only reliable way to tell "the token is
 * not accepted here" from "this account sees no spaces".
 */
async function whoami(base, auth) {
  try {
    const response = await fetch(`${base}/rest/api/user/current`, { headers: authHeaders(auth) })
    if (!response.ok) return null
    const payload = await response.json()
    return { type: String(payload?.type || ''), username: String(payload?.username || '') }
  } catch {
    return null
  }
}

async function fetchSpaces(base, auth) {
  const out = []
  let start = 0
  for (let guard = 0; guard < 40; guard += 1) {
    const target = `${base}/rest/api/space?type=global&type=personal&limit=100&start=${start}`
    const response = await fetch(target, { headers: authHeaders(auth) })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      const error = new Error(`Confluence answered ${response.status}${detail ? ': ' + detail : ''}`)
      error.code = response.status === 401 || response.status === 403
        ? 'error.connection.denied' : 'error.connection.http'
      error.status = response.status
      throw error
    }
    const payload = await response.json()
    const batch = payload.results || []
    for (const row of batch) out.push({ key: row.key, name: row.name || row.key, type: row.type })
    if (batch.length < 100) break
    start += batch.length
  }
  const seen = new Set()
  return out.filter(space => (seen.has(space.key) ? false : (seen.add(space.key), true)))
}

/** Fail loudly when the server ignored the credentials instead of a silent empty list. */
async function requireIdentity(base, auth) {
  const identity = await whoami(base, auth)
  if (identity && identity.type === 'anonymous') {
    const error = new Error('anonymous')
    error.code = 'error.authRejected'
    throw error
  }
  return identity
}

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

function pythonPath() {
  const runtime = join(process.env.USERPROFILE || homedir(), '.dsh', 'dsh-runtimes',
    'dsh-primary-runtime', 'dependencies', 'python')
  const candidates = [
    process.env.KB_PYTHON,
    join(runtime, 'python.exe'),
    join(runtime, 'bin', 'python3'),
    join(runtime, 'bin', 'python'),
    'python3',
    'python',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const isPath = candidate.includes('/') || candidate.includes('\\')
    if (!isPath || existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

function enginePath() {
  const candidates = [
    process.env.KB_ENGINE,
    join(homedir(), '.dsh', 'skills', 'knowledge-base', 'scripts', 'kb.py'),
    join(PLUGIN_DIR, '..', 'engine', 'kb.py'),
    join(PLUGIN_DIR, 'engine', 'kb.py'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[candidates.length - 1]
}

/** Run one engine command and collect its output; never throws on a non-zero exit. */
function runEngine(args, timeoutMs = 600_000) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = result => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn(pythonPath(), [enginePath(), ...args], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      })
    } catch (error) {
      done({ code: -1, stdout, stderr: String(error?.message ?? error) })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      done({ code: -1, stdout, stderr: stderr + '\ntimeout' })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      done({ code: -1, stdout, stderr: String(error?.message ?? error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      done({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** The last JSON object printed by an engine `--json` command. */
function lastEngineJson(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).reverse()
  for (const line of lines) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      return JSON.parse(text)
    } catch {
      /* keep looking */
    }
  }
  return null
}

function inspectArchive(path) {
  return new Promise(resolve => {
    if (!path) {
      resolve({ ok: false, code: 'file-missing' })
      return
    }
    const child = spawn(pythonPath(), [enginePath(), 'inspect', '--zip', path, '--json'], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => resolve({ ok: false, code: 'file-unreadable', detail: error.message }))
    child.on('close', () => {
      const parsed = parseInspect(stdout)
      resolve(parsed.ok ? parsed : { ...parsed, detail: stderr.trim().slice(0, 400) })
    })
  })
}

// ---------------------------------------------------------------------------
// jobs, one per source
// ---------------------------------------------------------------------------

const jobs = new Map()
const trackers = new Map()
const children = new Map()

function idleJob(sourceId) {
  return {
    sourceId,
    state: 'idle',
    source: '',
    mode: '',
    locale: '',
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    exitCode: null,
    cancelling: false,
    progress: { done: 0, total: 0, space: '', percent: null },
    lines: [],
    error: null,
    task: null,
    stats: null,
  }
}

function jobOf(sourceId) {
  if (!jobs.has(sourceId)) jobs.set(sourceId, idleJob(sourceId))
  return jobs.get(sourceId)
}

function trackerOf(sourceId) {
  if (!trackers.has(sourceId)) trackers.set(sourceId, new ProgressState())
  return trackers.get(sourceId)
}

let stdoutLines = []

function record(job, line) {
  const text = String(line).replace(/\s+$/, '')
  if (!text) return
  job.lines.push(text)
  if (job.lines.length > JOB_LINES) job.lines.shift()
}

function publicJob(sourceId) {
  const job = jobOf(sourceId)
  return {
    ...job,
    lines: job.lines.slice(-40),
    durationMs: elapsedMs(job, Date.now()),
    engine: { python: pythonPath(), script: enginePath() },
  }
}

/** Turn the finished run into an Automation task record (or report why not). */
async function publishReport(ctx, source, run, registry) {
  const schedule = ctx.get('schedule')
  if (!schedule) return { state: 'unavailable', code: 'task.unavailable' }
  const t = translator(run.locale ?? source.locale)
  const stats = run.stats ?? {}
  const target = run.source === 'file' ? source.filePath : source.baseUrl
  const durationSeconds = Math.max(1, Math.round((run.durationMs || 0) / 1000))
  const duration = durationSeconds >= 60
    ? t('duration.minutes', {
      minutes: Math.floor(durationSeconds / 60), seconds: durationSeconds % 60,
    })
    : t('duration.seconds', { seconds: durationSeconds })
  const result = run.state === 'done'
    ? t('task.result.success')
    : run.state === 'cancelled' ? t('task.result.cancelled') : t('task.result.failed')
  const startLabel = String(run.startedAt || '').slice(0, 16).replace('T', ' ')
  const rows = [
    t('task.card.heading'),
    t('task.card.source', { source: t(`source.${run.source}`) }),
    t('task.card.base', { name: source.name }),
    t('task.card.target', { target: target || '-' }),
    t('task.card.mode', { mode: t(`mode.${run.mode}`) }),
    t('task.card.started', { when: startLabel || '-' }),
    t('task.card.duration', { duration }),
    t('task.card.added', { count: stats.added ?? 0 }),
    t('task.card.changed', { count: stats.changed ?? 0 }),
    t('task.card.deprecated', { count: stats.deprecated ?? 0 }),
    t('task.card.skipped', { count: stats.skipped ?? 0 }),
    t('task.card.result', { result }),
  ]
  if (run.error) rows.push(t('task.card.error', { error: t(`error.${run.error.code}`, run.error.params) }))
  // The record exists so the run is visible in Automation tasks; it must not
  // read like a reminder that will fire, because the import is the plugin's own.
  rows.push('', t('task.card.purpose'))
  const prompt = rows.join('\n')
  const title = t('task.title', {
    source: source.name,
    date: String(run.finishedAt || '').slice(0, 16).replace('T', ' '),
  })

  try {
    if (source.taskId) {
      const edited = await schedule.edit({
        id: source.taskId,
        action: 'update',
        patch: { title, prompt },
      })
      if (edited && !edited.code) return { state: 'updated', id: source.taskId }
      if (edited?.code !== 'schedule_not_found') return { state: 'failed', code: 'task.rejected' }
    }
    const created = await schedule.create({
      title,
      prompt,
      // A record, not a reminder: one occurrence far in the future, paused right
      // after creation so it can never deliver into a conversation. The Host
      // requires a full local time (HH:mm:ss), not HH:mm.
      timing: {
        kind: 'at',
        at: { date: '2099-12-31', time: '23:59:00', time_zone: hostTimeZone() },
      },
      target: { kind: 'new_once' },
    })
    const id = created?.id
    if (!id) return { state: 'failed', code: 'task.rejected' }
    patchSource(registry, source.id, { taskId: id })
    const paused = await schedule.edit({ id, action: 'update', patch: { active: false } })
    return { state: paused?.code ? 'failed' : 'created', id, code: paused?.code ? 'task.pauseRejected' : '' }
  } catch (error) {
    return { state: 'failed', code: 'task.failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

function hostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

async function finish(ctx, sourceId, code, spawnError) {
  const job = jobOf(sourceId)
  const registry = loadRegistry()
  const source = sourceById(registry, sourceId)
  const state = job.cancelling ? 'cancelled' : spawnError || code !== 0 ? 'error' : 'done'
  job.exitCode = code
  job.finishedAt = new Date().toISOString()
  job.durationMs = elapsedMs(job, Date.now())
  job.stats = parseImportSummary(stdoutLines)
  if (spawnError) {
    job.error = { code: 'error.spawn', params: { detail: spawnError } }
  } else if (state === 'cancelled') {
    job.error = { code: 'error.cancelled', params: {} }
  } else if (code !== 0) {
    job.error = { code: 'error.exit', params: { code: String(code) } }
  }
  job.state = state
  const finishedError = job.error
  try {
    const patch = {
      lastRun: {
        state,
        source: job.source,
        mode: job.mode,
        finishedAt: job.finishedAt,
        durationMs: job.durationMs,
        stats: job.stats,
        error: finishedError,
      },
    }
    if (state === 'done') {
      patch.lastSuccess = job.finishedAt
      if (job.mode === 'full') patch.lastFull = job.finishedAt
      patch.lastError = ''
    } else if (state !== 'cancelled') {
      patch.lastError = finishedError?.code ?? 'error.exit'
    }
    if (source) patchSource(registry, sourceId, patch)
  } catch (error) {
    job.error = { code: 'error.stateWrite', params: { detail: String(error?.message ?? error).slice(0, 200) } }
  }

  job.task = { state: 'pending' }
  job.task = source
    ? await publishReport(ctx, source, {
      state, source: job.source, mode: job.mode,
      startedAt: job.startedAt, finishedAt: job.finishedAt, durationMs: job.durationMs,
      stats: job.stats, error: finishedError, locale: job.locale,
    }, registry)
    : { state: 'failed', code: 'task.failed' }
}

function spawnImport(source, { mode, locale, auth }) {
  const args = [enginePath(), '--kb', source.root]
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' }
  delete env.CONFLUENCE_TOKEN
  delete env.CONFLUENCE_PASSWORD
  // Secrets travel through the environment, never argv (process list, logs); the
  // Basic user name is not a secret and the engine takes it as a `fetch` flag.
  if (source.source === 'api' && auth?.kind === 'bearer' && auth.token) {
    env.CONFLUENCE_TOKEN = auth.token
  }
  if (source.source === 'api' && auth?.kind === 'basic' && auth.user) {
    env.CONFLUENCE_PASSWORD = auth.password
  }

  if (source.source === 'api') {
    const base = normalizeBaseUrl(source.baseUrl)
    args.push('fetch', '--url', base, '--progress')
    // Fetch's own options, after the subcommand: `--user` before `fetch` is
    // parsed as the subcommand choice and kb.py refuses to start.
    if (auth?.kind === 'basic' && auth.user) args.push('--user', auth.user)
    const spaces = source.spacesAll ? [] : (source.spaces || [])
    if (spaces.length) args.push('--spaces', spaces.join(','))
    if (mode === 'incremental' && source.lastSuccess) {
      args.push('--since', String(source.lastSuccess).slice(0, 10))
    }
    mkdirSync(join(source.root, 'raw'), { recursive: true })
    args.push('--save-zip', join(source.root, 'raw', `api-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`))
  } else {
    args.push('import', '--zip', source.filePath, '--progress')
    const spaces = source.spacesAll ? [] : (source.spaces || [])
    if (spaces.length) args.push('--spaces', spaces.join(','))
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath(), args, { env, windowsHide: true })
    children.set(source.id, proc)
    proc.on('error', error => reject(error))
    proc.stdout.on('data', chunk => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue
        stdoutLines.push(line)
        record(jobOf(source.id), line)
      }
    })
    proc.stderr.on('data', chunk => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue
        if (trackerOf(source.id).push(line)) {
          jobOf(source.id).progress = trackerOf(source.id).snapshot()
          continue
        }
        record(jobOf(source.id), line)
      }
    })
    proc.on('close', code => { children.delete(source.id); resolve(code ?? -1) })
  })
}

async function startImport(ctx, source, { full, locale }) {
  if (jobOf(source.id).state === 'running') {
    const error = new Error('busy')
    error.code = 'import.busy'
    throw error
  }
  let auth = { kind: source.auth, configured: false }
  if (source.source === 'api') {
    const checked = validateBaseUrl(source.baseUrl)
    if (!checked.ok) {
      const error = new Error(checked.code)
      error.code = 'error.' + checked.code
      throw error
    }
    auth = await resolveAuth(ctx, source)
    if (!auth.configured) {
      const error = new Error(auth.code)
      error.code = auth.code
      throw error
    }
    // Never start a pull the server will answer anonymously: it would import
    // nothing and report success.
    await requireIdentity(checked.value, auth)
    if (!source.spacesAll && (source.spaces || []).length === 0) {
      const error = new Error('no spaces')
      error.code = 'error.noSpaces'
      throw error
    }
  } else {
    if (!source.filePath) {
      const error = new Error('no file')
      error.code = 'error.filePathMissing'
      throw error
    }
    if (!existsSync(source.filePath)) {
      const error = new Error('file missing')
      error.code = 'error.fileMissing'
      throw error
    }
  }

  const job = idleJob(source.id)
  job.state = 'running'
  job.source = source.source
  job.mode = full ? 'full' : 'incremental'
  job.locale = LANGUAGES.has(locale) ? locale : source.locale
  job.startedAt = new Date().toISOString()
  jobs.set(source.id, job)
  trackerOf(source.id).reset()
  stdoutLines = []

  spawnImport(source, { mode: job.mode, locale: job.locale, auth })
    .then(code => finish(ctx, source.id, code))
    .catch(error => {
      const child = children.get(source.id)
      if (child) {
        try { child.kill() } catch { /* already gone */ }
      }
      return finish(ctx, source.id, -1, error instanceof Error ? error.message : String(error))
    })

  return publicJob(source.id)
}

function cancelImport(sourceId) {
  const job = jobOf(sourceId)
  const child = children.get(sourceId)
  if (job.state !== 'running' || !child) {
    const error = new Error('nothing to cancel')
    error.code = 'import.notRunning'
    throw error
  }
  job.cancelling = true
  child.kill('SIGTERM')
  return publicJob(sourceId)
}

// ---------------------------------------------------------------------------
// HTTP helpers and the route table
// ---------------------------------------------------------------------------

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res, code, params = {}, status = 400) {
  return json(res, status, { ok: false, error: code, params })
}

/** Route handlers report a refusal as data; the dispatcher turns it into the response. */
function failure(code, params = {}, status = 400) {
  return { ok: false, error: code, params, status }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > 128 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * A write may come from this app and nowhere else.
 *
 * DSH's own request fence trusts a request that carries no browser markers at
 * all (`Origin`/`Referer` absent): the desktop shell serves the page from the
 * `dsh-app://` scheme and forwards its requests here without an `Origin`, and a
 * local tool has none either. Everything else is checked against the listener
 * that received the request and the origin the web server advertises, so a page
 * on another site — which always attaches its own `Origin` to a POST — is still
 * refused.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function sameOrigin(req, advertised) {
  const origin = req.headers.origin
  const referer = req.headers.referer
  const host = req.headers.host || ''
  if (origin === undefined && referer === undefined) {
    return { ok: true, reason: 'no-browser-markers' }
  }
  const candidates = [origin, referer].filter(value => typeof value === 'string' && value !== '')
  for (const raw of candidates) {
    if (raw === 'null') continue
    let url
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol === 'dsh-app:') return { ok: true, reason: 'desktop-shell' }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    if (host && url.host === host) return { ok: true, reason: 'same-host' }
    if (advertised && url.host === advertised) return { ok: true, reason: 'advertised' }
    if (host && LOOPBACK.has(url.hostname) && LOOPBACK.has(String(host).replace(/:\d+$/, ''))) {
      const port = (value) => (/:(\d+)$/.exec(value) || [])[1] || ''
      if (port(url.host) === port(host)) return { ok: true, reason: 'loopback-alias' }
    }
  }
  return {
    ok: false,
    reason: 'foreign-origin',
    origin: String(origin ?? ''),
    referer: String(referer ?? ''),
    host,
  }
}

let lastRejectedWrite = null

function requestOrigin(webServer) {
  try {
    return new URL(webServer.getOrigin()).host
  } catch {
    return ''
  }
}

const INSPECT_CODES = {
  'file-missing': 'error.fileMissing',
  'file-empty': 'error.fileEmpty',
  'file-not-zip': 'error.fileNotZip',
  'file-no-pages': 'error.fileNoPages',
  'file-unreadable': 'error.fileUnreadable',
}

function inspectKey(code) {
  return INSPECT_CODES[code] ?? 'error.fileUnreadable'
}

function fileSummary(path) {
  try {
    const stat = statSync(path)
    return { bytes: stat.size, mtime: stat.mtime.toISOString() }
  } catch {
    return { bytes: 0, mtime: '' }
  }
}

/** Everything the page may see about one source: never a token or password. */
function publicSource(source, registry, extra = {}) {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    source: source.source,
    auth: source.auth,
    baseUrl: source.baseUrl,
    filePath: source.filePath,
    file: source.filePath ? fileSummary(source.filePath) : null,
    spaces: source.spaces,
    spacesAll: source.spacesAll,
    root: source.root,
    schedule: source.schedule,
    lastSuccess: source.lastSuccess,
    lastFull: source.lastFull,
    lastError: source.lastError,
    lastRun: source.lastRun,
    taskId: source.taskId,
    imported: Boolean(source.imported),
    urlLocked: urlLockedFor(source),
    isDefault: source.id === registry.defaultId,
    ...extra,
  }
}

function countArticles(root) {
  let count = 0
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!['raw', 'attachments', '.git', 'node_modules'].includes(entry.name)) walk(full, depth + 1)
        continue
      }
      if (entry.name.endsWith('.md') && entry.name !== 'INDEX.md' && entry.name !== 'README.md') {
        try {
          if (statSync(full).size > 0) count += 1
        } catch {
          /* unreadable article does not change the count */
        }
      }
    }
  }
  walk(root, 0)
  return count
}

function sourceList(registry) {
  return registry.sources.map(source => ({
    id: source.id,
    name: source.name,
    source: source.source,
    auth: source.auth,
    baseUrl: source.baseUrl,
    filePath: source.filePath,
    root: source.root,
    isDefault: source.id === registry.defaultId,
    imported: Boolean(source.imported),
    urlLocked: urlLockedFor(source),
    articleCount: countArticles(source.root),
    lastSuccess: source.lastSuccess,
    lastError: source.lastError,
    job: { state: jobOf(source.id).state },
  }))
}

async function credentialFlags(ctx, source) {
  const credentials = ctx.get('credentials')
  let tokenConfigured = false
  let basicConfigured = false
  let basicUser = ''
  const stored = await readCredential(ctx, source)
  const payload = stored?.kind === 'grant' ? stored.payload : undefined
  if (payload?.auth === 'token') tokenConfigured = Boolean(payload.token)
  if (payload?.auth === 'basic') {
    basicConfigured = Boolean(payload.user && payload.password)
    basicUser = basicConfigured ? String(payload.user) : ''
  }
  return { tokenConfigured, basicConfigured, basicUser, credentialsAvailable: Boolean(credentials) }
}

async function stateOf(ctx, source, registry) {
  const flags = await credentialFlags(ctx, source)
  return {
    ok: true,
    ...publicSource(source, registry, {
      ...flags,
      kbRoot: source.root,
      articleCount: countArticles(source.root),
      nextRun: dueMode(source, Date.now()),
      job: publicJob(source.id),
      lastRejectedWrite,
    }),
  }
}

/** Workspaces the page may bind, with the sources each one already uses. */
function workspaceList(ctx, registry) {
  const workspaces = ctx.get('workspaceRegistry')
  let rows = []
  try {
    rows = workspaces?.list?.() || []
  } catch {
    rows = []
  }
  return rows.map(workspace => ({
    id: String(workspace.id),
    title: String(workspace.title || workspace.path || workspace.id),
    path: String(workspace.path || ''),
    sources: registry.workspaces?.[String(workspace.id)] || [],
  }))
}

// ---------------------------------------------------------------------------
// exports shared with the tool half
// ---------------------------------------------------------------------------

/** The current source registry, migrated and with roots resolved. */
export function loadSources() {
  return loadRegistry()
}

/**
 * Workspace owning the calling Agent's directory, or an empty string.
 *
 * The tools use it to pick the workspace's source set. A missing service, a
 * disposed directory, or an unowned directory all simply mean "no binding", and
 * the default source applies.
 */
export async function workspaceIdFor(ctx, agent, signal) {
  if (!agent) return ''
  let directory = ''
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory) {
    try {
      directory = await workingDirectory.ensure(agent, signal)
    } catch {
      directory = ''
    }
  }
  if (!directory) return ''
  const workspaces = ctx.get('workspaceRegistry')
  if (!workspaces?.resolveByPath) return ''
  try {
    const workspace = await workspaces.resolveByPath(directory)
    return workspace ? String(workspace.id) : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// portable base archives
// ---------------------------------------------------------------------------

function codedError(code, detail = '') {
  const error = new Error(detail || code)
  error.code = code
  if (detail) error.detail = detail
  return error
}

function exportsDirectory() {
  return join(kbHome(), 'exports')
}

/** Characters Windows forbids in a file name; the same rule keeps the path one segment. */
const UNSAFE_EXPORT_NAME = /[<>:"/\\|?*\x00-\x1f]/
const RESERVED_EXPORT_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function defaultExportDirectory() {
  const documents = join(homedir(), 'Documents')
  return existsSync(documents) ? documents : homedir()
}

/** Where the export dialog starts: the user's Documents and a name from the source. */
function exportPlan(source) {
  const base = String(source.name || source.id || 'knowledge-base')
    .replace(UNSAFE_EXPORT_NAME, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60) || 'knowledge-base'
  return {
    directory: defaultExportDirectory(),
    fileName: `${base}-${new Date().toISOString().slice(0, 10)}.zip`,
  }
}

/** One file name, never a path; `.zip` is added when the user leaves it out. */
function cleanExportName(raw) {
  let name = String(raw ?? '').trim()
  if (!name) throw codedError('error.exportName')
  if (!/\.zip$/i.test(name)) name += '.zip'
  if (UNSAFE_EXPORT_NAME.test(name) || name.length > 120) throw codedError('error.exportName')
  if (name.startsWith('.') || name.endsWith('.') || name.endsWith(' ')) throw codedError('error.exportName')
  if (RESERVED_EXPORT_NAME.test(name.replace(/\.zip$/i, ''))) name = `kb-${name}`
  return name
}

/** An existing absolute directory; the plugin never creates one the user typed. */
function exportDirectory(raw) {
  const value = String(raw ?? '').trim() || defaultExportDirectory()
  if (!isAbsolute(value)) throw codedError('error.exportDirectory')
  const resolved = resolve(value)
  let info
  try {
    info = statSync(resolved)
  } catch {
    throw codedError('error.exportDirectory')
  }
  if (!info.isDirectory()) throw codedError('error.exportDirectory')
  return resolved
}

const exportJobs = new Map()

function idleExportJob(sourceId) {
  return {
    sourceId,
    state: 'idle',
    path: '',
    bytes: 0,
    articles: 0,
    files: 0,
    progress: { done: 0, total: 0, percent: null },
    startedAt: '',
    finishedAt: '',
    cancelling: false,
    settled: false,
    error: null,
  }
}

function exportJobOf(sourceId) {
  if (!exportJobs.has(sourceId)) exportJobs.set(sourceId, idleExportJob(sourceId))
  return exportJobs.get(sourceId)
}

function publicExportJob(sourceId) {
  const { child, ...rest } = exportJobOf(sourceId)
  return rest
}

/** `PACK <done>/<total>` from `kb.py pack --progress`, in bytes. */
function recordExportProgress(job, line) {
  const match = /^PACK (\d+)\/(\d+)$/.exec(String(line).trim())
  if (!match) return false
  const done = Number(match[1])
  const total = Number(match[2])
  job.progress = {
    done,
    total,
    percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null,
  }
  return true
}

/** Pack one base in the background, into the exact path the user chose. */
function startExport(source, body = {}) {
  if (jobOf(source.id).state === 'running') throw codedError('import.busy')
  if (exportJobOf(source.id).state === 'running') throw codedError('error.exportBusy')
  const root = baseInsideKb(source.root)
  if (!root || !existsSync(root)) throw codedError('error.baseMissing')
  const directory = exportDirectory(body.directory)
  const fileName = cleanExportName(body.fileName)
  const out = join(directory, fileName)
  // Replacing an existing archive is allowed only after the page asked the
  // operator; the pack still writes a temporary file and renames on success, so
  // a failed run leaves the old archive untouched.
  if (existsSync(out) && !body.overwrite) throw codedError('error.exportExists', fileName)
  const metaDir = exportsDirectory()
  mkdirSync(metaDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const metaFile = join(metaDir, `.meta-${process.pid}-${stamp}.json`)
  writeFileSync(metaFile, JSON.stringify(exportMetadata(source)), 'utf8')

  const job = idleExportJob(source.id)
  job.state = 'running'
  job.path = out
  job.startedAt = new Date().toISOString()
  exportJobs.set(source.id, job)

  let stdout = ''
  let stderr = ''
  let child
  try {
    child = spawn(pythonPath(), [
      enginePath(), '--kb', root, 'pack', '--out', out, '--meta', metaFile, '--progress', '--json',
    ], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true })
  } catch (error) {
    finishExport(job, -1, '', String(error?.message ?? error), metaFile, out)
    return publicExportJob(source.id)
  }
  job.child = child
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    stderr += text
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) recordExportProgress(job, line)
    }
  })
  child.on('error', error => {
    finishExport(job, -1, stdout, String(error?.message ?? error), metaFile, out)
  })
  child.on('close', code => {
    finishExport(job, code ?? -1, stdout, stderr, metaFile, out)
  })
  return publicExportJob(source.id)
}

function finishExport(job, code, stdout, stderr, metaFile, out) {
  if (job.settled) return
  job.settled = true
  try { rmSync(metaFile, { force: true }) } catch { /* best effort */ }
  const answer = lastEngineJson(stdout)
  job.finishedAt = new Date().toISOString()
  job.child = null
  if (job.cancelling) {
    job.state = 'cancelled'
    job.error = { code: 'error.cancelled', params: {} }
    try { rmSync(out, { force: true }) } catch { /* best effort */ }
  } else if (code === 0 && answer?.ok) {
    job.state = 'done'
    job.bytes = answer.bytes ?? 0
    job.articles = answer.articles ?? 0
    job.files = answer.files ?? 0
    job.progress = { done: 1, total: 1, percent: 100 }
    job.error = null
  } else {
    job.state = 'error'
    job.error = {
      code: 'error.exportFailed',
      params: { detail: String(answer?.detail || stderr || '').slice(0, 200) },
    }
  }
  // The engine writes `<name>.tmp` and renames it; a killed run leaves it behind.
  try { rmSync(`${out}.tmp`, { force: true }) } catch { /* best effort */ }
}

function cancelExport(sourceId) {
  const job = exportJobOf(sourceId)
  if (job.state !== 'running' || !job.child) return publicExportJob(sourceId)
  job.cancelling = true
  try { job.child.kill() } catch { /* already gone */ }
  return publicExportJob(sourceId)
}

/**
 * Show the exported archive in the OS file manager, with the file selected.
 *
 * Only a finished export's own path is ever revealed — the route takes no path
 * from the page — so this cannot become a "open anything on disk" primitive.
 * `explorer.exe` reports exit code 1 even on success, so it is never awaited.
 */
function revealExport(source, logger) {
  const job = exportJobOf(source.id)
  if (job.state !== 'done' || !job.path) throw codedError('error.revealMissing')
  const target = resolve(job.path)
  if (!existsSync(target)) throw codedError('error.revealMissing')
  let command
  let args
  let verbatim = false
  if (process.platform === 'win32') {
    command = 'explorer.exe'
    // Explorer wants `/select,"<path>"` as one token; verbatim keeps Node from
    // re-quoting the switch along with the path (or splitting the folder name).
    args = [`/select,"${target}"`]
    verbatim = true
  } else if (process.platform === 'darwin') {
    command = 'open'
    args = ['-R', target]
  } else {
    command = 'xdg-open'
    args = [dirname(target)]
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    ...(verbatim ? { windowsVerbatimArguments: true } : {}),
  })
  child.on('error', error => {
    logger?.warn?.(`knowledge-base: could not reveal the export: ${error?.message ?? error}`)
  })
  child.unref()
  return target
}

/** Public metadata of one source: everything worth carrying, no secret. */
function exportMetadata(source) {
  return {
    name: source.name,
    source: source.source,
    baseUrl: source.baseUrl,
    spaces: source.spaces,
    spacesAll: Boolean(source.spacesAll),
    schedule: source.schedule,
    locale: source.locale,
    lastSuccess: source.lastSuccess,
    lastFull: source.lastFull,
  }
}

const ARCHIVE_CODES = {
  'archive-missing': 'error.importFile',
  'archive-invalid': 'error.importFormat',
  'archive-meta-missing': 'error.importFormat',
  'archive-format': 'error.importFormat',
  'archive-version': 'error.importFormat',
  'archive-meta-invalid': 'error.importFormat',
  'archive-empty': 'error.importFormat',
  'archive-unsafe': 'error.importUnsafe',
}

/** Create a new source from a portable archive the user points at. */
async function importBase(registry, filePath) {
  const path = String(filePath || '').trim()
  if (!path) throw codedError('error.importPath')
  if (!existsSync(path)) throw codedError('error.importFile')
  const checked = await runEngine(['unpack', '--archive', path, '--check', '--json'], 120_000)
  const summary = lastEngineJson(checked.stdout)
  if (!summary?.ok) {
    const code = ARCHIVE_CODES[String(summary?.code || '')] || 'error.importFormat'
    throw codedError(code, String(summary?.detail || '').slice(0, 200))
  }
  const meta = summary.source && typeof summary.source === 'object' ? summary.source : {}
  const name = String(meta.name || '').trim() || 'Imported'
  const id = uniqueId(name, registry.sources.map(source => source.id))
  const root = join(kbHome(), id)
  const kind = meta.source === 'file' ? 'file' : 'api'
  let baseUrl = ''
  if (kind === 'api') {
    const url = validateBaseUrl(meta.baseUrl || '')
    if (!url.ok) throw codedError('error.importFormat', 'baseUrl')
    baseUrl = url.value
  }
  const unpacked = await runEngine(['--kb', root, 'unpack', '--archive', path, '--json'])
  const done = lastEngineJson(unpacked.stdout)
  if (!done?.ok) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
    throw codedError('error.importFailed', String(done?.detail || unpacked.stderr).slice(0, 200))
  }
  const created = normalizeSource({
    ...blankSource(id, name),
    name,
    source: kind,
    baseUrl,
    spaces: Array.isArray(meta.spaces) ? meta.spaces.map(String).slice(0, 2000) : [],
    spacesAll: Boolean(meta.spacesAll),
    schedule: meta.schedule && typeof meta.schedule === 'object' ? meta.schedule : {},
    locale: LANGUAGES.has(meta.locale) ? meta.locale : 'en',
    lastSuccess: String(meta.lastSuccess || ''),
    lastFull: String(meta.lastFull || ''),
    // The base arrived with its URL: that URL is part of the content and is
    // frozen from now on.
    imported: true,
    root,
  }, id)
  registry.sources.push(created)
  if (!registry.defaultId) registry.defaultId = id
  saveRegistry(registry)
  return {
    id,
    name,
    articles: done.articles ?? summary.articles ?? 0,
    source: created,
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function registerSettingsUi(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) {
    // Never fail silently: without the carrier every route 404s and the page
    // shows an error instead of the settings.
    ctx.logger?.warn?.('knowledge-base: the web server is unavailable, so the settings routes are not registered')
    return
  }

  const sourceRoutes = {
    async state(source, registry) {
      return { ok: true, ...(await stateOf(ctx, source, registry)) }
    },
    async test(source, registry, body) {
      // The page tests the kind and credentials it is showing, not the saved ones.
      const kind = (body.source ?? source.source) === 'file' ? 'file' : 'api'
      if (kind === 'file') {
        const path = String(body.filePath ?? source.filePath ?? '').trim()
        const result = await inspectArchive(path)
        if (!result.ok) return failure(inspectKey(result.code), { detail: result.detail || '' })
        return {
          ok: true,
          source: 'file',
          spaces: (result.spaces || []).map(space => ({ key: space.key, name: space.name, pages: space.pages })),
          pages: result.pages ?? 0,
          bytes: result.bytes ?? 0,
          unsorted: result.unsorted ?? 0,
        }
      }
      const checked = validateBaseUrl(body.baseUrl ?? source.baseUrl)
      if (!checked.ok) return failure('error.' + checked.code)
      // Values the user just typed are tested as typed; they are not saved here.
      const mode = body.auth === 'basic' ? 'basic' : body.auth === 'bearer' ? 'bearer' : source.auth
      const saved = await resolveAuth(ctx, { ...source, auth: mode })
      const auth = mode === 'basic'
        ? {
          user: String(body.user ?? saved.user ?? '').trim(),
          password: String(body.password ?? saved.password ?? ''),
        }
        : { token: String(body.token ?? saved.token ?? '').trim() }
      const configured = auth.user !== undefined
        ? Boolean(auth.user && auth.password) : Boolean(auth.token)
      if (!configured) return failure(mode === 'basic' ? 'error.basicMissing' : 'error.tokenMissing')
      try {
        const identity = await requireIdentity(checked.value, auth)
        const spaces = await fetchSpaces(checked.value, auth)
        return {
          ok: true,
          source: 'api',
          spaces,
          pages: 0,
          bytes: 0,
          unsorted: 0,
          identity: { type: identity?.type || '', username: identity?.username || '' },
        }
      } catch (error) {
        return failure(error.code || 'error.connection', { detail: String(error.message || error).slice(0, 300) })
      }
    },
    async spaces(source) {
      if (source.source === 'file') {
        const result = await inspectArchive(source.filePath)
        if (!result.ok) return failure(inspectKey(result.code))
        return {
          ok: true,
          source: 'file',
          spaces: (result.spaces || []).map(space => ({ key: space.key, name: space.name, pages: space.pages })),
          pages: result.pages ?? 0,
          bytes: result.bytes ?? 0,
        }
      }
      const checked = validateBaseUrl(source.baseUrl)
      if (!checked.ok) return failure('error.' + checked.code)
      const auth = await resolveAuth(ctx, source)
      if (!auth.configured) return failure(auth.code)
      try {
        await requireIdentity(checked.value, auth)
        return { ok: true, source: 'api', spaces: await fetchSpaces(checked.value, auth) }
      } catch (error) {
        return failure(error.code || 'error.connection', { detail: String(error.message || error).slice(0, 300) })
      }
    },
    async import(source, registry, body) {
      const started = await startImport(ctx, source, { full: Boolean(body.full), locale: body.locale })
      return { ok: true, job: started }
    },
    async cancel(source) {
      return { ok: true, job: cancelImport(source.id) }
    },
    async job(source) {
      return { ok: true, ...publicJob(source.id) }
    },
    async token(source, registry, body) {
      const credentials = ctx.get('credentials')
      if (!credentials) return failure('error.credentials')
      const key = credentialKeyFor(source.id)
      const token = String(body?.token || '').trim()
      if (!token) {
        await credentials.deleteRecord(key)
        return { ok: true, tokenConfigured: false }
      }
      await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { auth: 'token', token } }))
      return { ok: true, tokenConfigured: true }
    },
    async basic(source, registry, body) {
      const credentials = ctx.get('credentials')
      if (!credentials) return failure('error.credentials')
      const key = credentialKeyFor(source.id)
      const user = String(body?.user || '').trim()
      const password = String(body?.password || '')
      if (!user || !password) {
        await credentials.deleteRecord(key)
        return { ok: true, basicConfigured: false, basicUser: '' }
      }
      await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { auth: 'basic', user, password } }))
      return { ok: true, basicConfigured: true, basicUser: user }
    },
  }

  const dispatcher = async (req, res) => {
    const url = new URL(req.url || '/', 'http://placeholder')
    const parts = url.pathname.slice(PREFIX.length).split('/').filter(Boolean)
    const method = req.method || 'GET'
    const isWrite = method !== 'GET' && method !== 'HEAD'

    if (isWrite) {
      const verdict = sameOrigin(req, requestOrigin(webServer))
      if (!verdict.ok) {
        lastRejectedWrite = { at: new Date().toISOString(), method, route: '/' + parts.join('/'), ...verdict }
        return fail(res, 'error.crossOrigin', {}, 403)
      }
    }

    try {
      if (method === 'GET' && parts.length === 2 && parts[0] === 'locale' && /^[a-z]{2}\.json$/.test(parts[1])) {
        const lang = parts[1].slice(0, 2)
        if (!LANGUAGES.has(lang)) return fail(res, 'error.notFound', {}, 404)
        const body = readFileSync(join(PLUGIN_DIR, 'locale', `${lang}.json`), 'utf8')
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        return res.end(body)
      }

      const registry = loadRegistry()

      // ---- the registry itself ------------------------------------------
      if (method === 'GET' && parts.length === 1 && parts[0] === 'sources') {
        return json(res, 200, {
          ok: true,
          defaultId: registry.defaultId,
          sources: sourceList(registry),
          workspaces: workspaceList(ctx, registry),
          registryFile: registryFile(),
        })
      }

      if (method === 'POST' && parts.length === 1 && parts[0] === 'sources') {
        const body = await readBody(req)
        const id = uniqueId(body.id || body.name || 'source', registry.sources.map(source => source.id))
        const root = join(kbHome(), id)
        const created = normalizeSource({ ...blankSource(id, body.name || id), ...body, id, root }, id)
        created.root = root
        registry.sources.push(created)
        if (!registry.defaultId) registry.defaultId = id
        saveRegistry(registry)
        return json(res, 200, { ok: true, id, source: publicSource(created, registry) })
      }

      if (method === 'POST' && parts.length === 1 && parts[0] === 'default') {
        const body = await readBody(req)
        if (!sourceById(registry, String(body.id))) return fail(res, 'error.sourceMissing')
        registry.defaultId = String(body.id)
        saveRegistry(registry)
        return json(res, 200, { ok: true, defaultId: registry.defaultId })
      }

      if (method === 'POST' && parts.length === 1 && parts[0] === 'pick-folder') {
        const picker = ctx.get('directoryPickerController')
        if (!picker || typeof picker.pick !== 'function') return fail(res, 'error.noPicker')
        try {
          const picked = await picker.pick(AbortSignal.timeout(600_000))
          return json(res, 200, { ok: true, path: picked ?? null })
        } catch (error) {
          return fail(res, 'error.pickerFailed', {
            detail: String(error?.message ?? error).slice(0, 200),
          })
        }
      }

      if (method === 'POST' && parts.length === 1 && parts[0] === 'import-base') {
        const body = await readBody(req)
        const imported = await importBase(registry, body.filePath)
        return json(res, 200, {
          ok: true,
          id: imported.id,
          name: imported.name,
          articles: imported.articles,
          source: await stateOf(ctx, imported.source, registry),
        })
      }

      if (method === 'POST' && parts.length === 1 && parts[0] === 'workspaces') {
        const body = await readBody(req)
        const workspaceId = String(body.workspaceId || '').trim()
        if (!workspaceId) return fail(res, 'error.workspaceMissing')
        const known = new Set(registry.sources.map(source => source.id))
        const chosen = (Array.isArray(body.sources) ? body.sources : [])
          .map(String).filter(id => known.has(id))
        if (chosen.length) registry.workspaces[workspaceId] = [...new Set(chosen)]
        else delete registry.workspaces[workspaceId]
        saveRegistry(registry)
        return json(res, 200, { ok: true, workspaces: workspaceList(ctx, registry) })
      }

      // ---- one source ---------------------------------------------------
      if (parts[0] === 'sources' && parts.length >= 2) {
        const id = parts[1]
        const action = parts[2] || ''
        const source = sourceById(registry, id)
        if (!source) return fail(res, 'error.sourceMissing', {}, 404)

        if (method === 'POST' && action === 'delete') {
          if (jobOf(id).state === 'running') return fail(res, 'import.busy')
          const inside = baseInsideKb(source.root)
          if (!inside) return fail(res, 'error.baseOutside')
          registry.sources = registry.sources.filter(entry => entry.id !== id)
          for (const [workspaceId, ids] of Object.entries(registry.workspaces)) {
            const left = ids.filter(entry => entry !== id)
            if (left.length) registry.workspaces[workspaceId] = left
            else delete registry.workspaces[workspaceId]
          }
          if (registry.defaultId === id) {
            registry.defaultId = registry.sources.length ? registry.sources[0].id : ''
          }
          saveRegistry(registry)
          // A deleted source leaves nothing behind: no files, no credential.
          try { rmSync(inside, { recursive: true, force: true }) } catch { /* locked file */ }
          const credentials = ctx.get('credentials')
          if (credentials) {
            try { await credentials.deleteRecord(credentialKeyFor(id)) } catch { /* already gone */ }
          }
          return json(res, 200, { ok: true, defaultId: registry.defaultId })
        }

        if (method === 'POST' && action === 'clear') {
          if (jobOf(id).state === 'running') return fail(res, 'import.busy')
          const inside = baseInsideKb(source.root)
          if (!inside) return fail(res, 'error.baseOutside')
          try {
            rmSync(inside, { recursive: true, force: true })
          } catch (error) {
            return fail(res, 'error.clearFailed', { detail: String(error?.message ?? error).slice(0, 200) })
          }
          const cleared = patchSource(registry, id, {
            lastSuccess: '', lastFull: '', lastRun: null, lastError: '',
          })
          return json(res, 200, { ok: true, source: await stateOf(ctx, cleared, registry) })
        }

        if (action === 'export') {
          const sub = parts[3] || ''
          if (method === 'GET' && !sub) {
            // A cancelled run leaves nothing to report; opening the plan again
            // starts from idle instead of resurfacing "cancelled" later.
            if (exportJobOf(source.id).state === 'cancelled') exportJobs.delete(source.id)
            return json(res, 200, { ok: true, ...exportPlan(source), job: publicExportJob(source.id) })
          }
          if (method === 'GET' && sub === 'job') {
            return json(res, 200, { ok: true, ...publicExportJob(source.id) })
          }
          if (method === 'POST' && !sub) {
            const body = await readBody(req)
            return json(res, 200, { ok: true, job: startExport(source, body) })
          }
          if (method === 'POST' && sub === 'cancel') {
            return json(res, 200, { ok: true, job: cancelExport(source.id) })
          }
          if (method === 'POST' && sub === 'reveal') {
            return json(res, 200, { ok: true, path: revealExport(source, ctx.logger) })
          }
          return fail(res, 'error.notFound', {}, 404)
        }

        if (method === 'POST' && action === '') {
          const body = await readBody(req)
          if (urlLockedFor(source) && body.baseUrl !== undefined
            && normalizeBaseUrl(body.baseUrl) !== normalizeBaseUrl(source.baseUrl)) {
            return fail(res, 'error.baseUrlLocked')
          }
          const updated = normalizeSource({
            ...source,
            ...body,
            id,
            root: source.root,
          }, id)
          const index = registry.sources.findIndex(entry => entry.id === id)
          registry.sources[index] = updated
          if (LANGUAGES.has(body.locale)) updated.locale = body.locale
          saveRegistry(registry)
          return json(res, 200, { ok: true, source: await stateOf(ctx, updated, registry) })
        }

        if (sourceRoutes[action]) {
          if (method === 'GET' && action !== 'state' && action !== 'job' && action !== 'spaces') {
            return fail(res, 'error.notFound', {}, 404)
          }
          const body = action === 'state' || action === 'job' || action === 'spaces' ? {} : await readBody(req)
          const result = await sourceRoutes[action](source, registry, body)
          if (result && result.ok === false) {
            return fail(res, result.error, result.params, result.status || 400)
          }
          return json(res, 200, result)
        }
        return fail(res, 'error.notFound', {}, 404)
      }

      // ---- legacy single-source routes act on the default source --------
      const legacy = parts.length === 1 ? parts[0] : ''
      const source = defaultSource(registry)
      if (!source && legacy) return fail(res, 'error.noSources', {}, 409)
      if (legacy === 'state' && method === 'GET') {
        return json(res, 200, {
          ...(await stateOf(ctx, source, registry)),
          defaultId: registry.defaultId,
          sources: sourceList(registry),
        })
      }
      if (legacy === 'config' && method === 'POST') {
        const body = await readBody(req)
        if (urlLockedFor(source) && body.baseUrl !== undefined
          && normalizeBaseUrl(body.baseUrl) !== normalizeBaseUrl(source.baseUrl)) {
          return fail(res, 'error.baseUrlLocked')
        }
        const checked = validateBaseUrl(body.baseUrl)
        if ((body.source ?? source.source) === 'api' && checked.value && !checked.ok) {
          return fail(res, 'error.' + checked.code)
        }
        const updated = normalizeSource({
          ...source,
          source: body.source === 'file' ? 'file' : 'api',
          auth: body.auth === 'basic' ? 'basic' : 'bearer',
          baseUrl: checked.ok ? checked.value : '',
          filePath: String(body.filePath || '').trim(),
          spaces: Array.isArray(body.spaces) ? body.spaces.map(String).slice(0, 2000) : [],
          spacesAll: Boolean(body.spacesAll),
          schedule: {
            incrementalDays: clampInt(body.incrementalDays, 1, 3650, 7),
            fullDays: clampInt(body.fullDays, 1, 3650, 30),
          },
          ...(body.name ? { name: String(body.name) } : {}),
          ...(LANGUAGES.has(body.locale) ? { locale: body.locale } : {}),
        }, source.id)
        const index = registry.sources.findIndex(entry => entry.id === source.id)
        registry.sources[index] = updated
        saveRegistry(registry)
        return json(res, 200, { ok: true, state: publicSource(updated, registry) })
      }
      if (legacy && sourceRoutes[legacy] && (method === 'GET'
        ? ['spaces', 'job'].includes(legacy) : true)) {
        const body = method === 'GET' ? {} : await readBody(req)
        const result = await sourceRoutes[legacy](source, registry, body)
        if (result && result.ok === false) return fail(res, result.error, result.params, result.status || 400)
        return json(res, 200, result)
      }

      return fail(res, 'error.notFound', {}, 404)
    } catch (error) {
      const code = error instanceof Error && error.code ? String(error.code) : 'error.internal'
      return fail(res, code, { detail: error instanceof Error ? error.message.slice(0, 300) : String(error) })
    }
  }

  const disposeRoute = webServer.register({ kind: 'prefix', path: PREFIX, handler: dispatcher })

  // Hourly tick: imports run in the Host, not in a chat session, so they keep
  // working with no browser open. Every source keeps its own schedule.
  const timer = setInterval(() => {
    const registry = loadRegistry()
    for (const source of registry.sources) {
      if (jobOf(source.id).state === 'running') continue
      const mode = dueMode(source, Date.now())
      if (!mode) continue
      startImport(ctx, source, { full: mode === 'full', locale: source.locale })
        .catch(error => ctx.logger?.warn?.(`knowledge-base ${source.id}: ${error?.code ?? error}`))
    }
  }, 60 * 60 * 1000)
  if (typeof timer.unref === 'function') timer.unref()

  ctx.effect(() => () => {
    clearInterval(timer)
    for (const child of children.values()) {
      try { child.kill() } catch { /* process already gone */ }
    }
    disposeRoute()
  })
}
