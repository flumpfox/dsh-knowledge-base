/**
 * Pure helpers for the Confluence knowledge base plugin.
 *
 * Nothing in this module touches the filesystem, a child process, a socket, or
 * the browser: given the same input it returns the same output, so the tests can
 * pin the progress contract, schedule arithmetic, and URL validation without a
 * running Host.
 */

/** Prefix of the machine-readable progress line kb.py writes to stderr. */
export const PROGRESS_PREFIX = 'PROGRESS '

/**
 * `PROGRESS <done>/<total> <space>`, with the space omitted while it is unknown
 * (the first line of an archive import, before any page is parsed).
 */
export const PROGRESS_PATTERN = /^PROGRESS (\d+)\/(\d+)(?: (\S.*))?$/

const DAY_MS = 24 * 60 * 60 * 1000

/** Parse one stderr line into progress, or null when it is not a progress line. */
export function parseProgressLine(line) {
  if (typeof line !== 'string') return null
  const match = PROGRESS_PATTERN.exec(line.trim())
  if (!match) return null
  const total = Number(match[2])
  const done = Math.min(Number(match[1]), total > 0 ? total : Number(match[1]))
  return { done, total, space: match[3] ? match[3].trim() : '' }
}

/** Running progress of one import: the latest line wins, totals may grow. */
export class ProgressState {
  constructor() {
    this.done = 0
    this.total = 0
    this.space = ''
    this.seen = false
  }

  /** Apply one progress line; returns true when it was a progress line. */
  push(line) {
    const next = parseProgressLine(line)
    if (!next) return false
    this.done = next.done
    this.total = next.total
    this.space = next.space
    this.seen = true
    return true
  }

  /** Forget the previous run before a new import starts. */
  reset() {
    this.done = 0
    this.total = 0
    this.space = ''
    this.seen = false
  }

  /** Snapshot for the job payload: percent is null when the total is unknown. */
  snapshot() {
    const percent = this.total > 0 ? Math.min(100, Math.round((this.done / this.total) * 100)) : null
    return { done: this.done, total: this.total, space: this.space, percent }
  }
}

/**
 * Read the `import summary` block kb.py prints on stdout.
 * Missing counters stay 0, so a failed run still produces a report.
 */
export function parseImportSummary(lines) {
  const stats = { added: 0, changed: 0, unchanged: 0, deprecated: 0, skipped: 0, filtered: 0 }
  for (const line of lines) {
    const match = /^\s*(added|changed|unchanged|deprecated|skipped|filtered)\s+(\d+)\s*$/.exec(String(line))
    if (match) stats[match[1]] = Number(match[2])
  }
  return stats
}

/** Trim, drop trailing slashes, keep the scheme and host as the user wrote them. */
export function normalizeBaseUrl(raw) {
  return String(raw ?? '').trim().replace(/\/+$/, '')
}

/**
 * Validate a Confluence base URL.
 * Returns `{ ok, value, code }`; `code` is a locale key suffix, never prose.
 */
export function validateBaseUrl(raw) {
  const value = normalizeBaseUrl(raw)
  if (!value) return { ok: false, value: '', code: 'url.empty' }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, value, code: 'url.invalid' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, value, code: 'url.scheme' }
  }
  if (!parsed.hostname) return { ok: false, value, code: 'url.invalid' }
  return { ok: true, value: normalizedForHost(value), code: '' }
}

/** A URL without a path is the server root; keep an explicit path such as /confluence. */
function normalizedForHost(value) {
  try {
    const parsed = new URL(value)
    const path = parsed.pathname.replace(/\/+$/, '')
    return parsed.origin + path
  } catch {
    return value
  }
}

/** Coerce a numeric form field into an integer inside bounds. */
export function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

/**
 * Which import the schedule asks for now: '', 'incremental', or 'full'.
 *
 * The file source has no `--since`, so a due file import is always a full pass
 * over the same archive; the API source takes only pages changed since the last
 * success and falls back to a full pass every `fullDays`.
 */
export function dueMode(state, nowMs) {
  const schedule = state?.schedule ?? {}
  const incrementalDays = clampInt(schedule.incrementalDays, 1, 3650, 7)
  const fullDays = clampInt(schedule.fullDays, 1, 3650, 30)
  const configured = state?.source === 'file' ? state?.filePath : state?.baseUrl
  if (!configured) return ''
  const since = (stamp) => {
    const parsed = Date.parse(String(stamp ?? ''))
    return Number.isNaN(parsed) ? Infinity : (nowMs - parsed) / DAY_MS
  }
  if (state?.source === 'file') {
    return since(state.lastSuccess) >= incrementalDays ? 'full' : ''
  }
  if (since(state.lastFull) >= fullDays) return 'full'
  if (since(state.lastSuccess) >= incrementalDays) return 'incremental'
  return ''
}

/** Replace `{name}` placeholders with parameter values; unknown names stay as written. */
export function interpolate(template, params = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
}

/** Read the JSON kb.py inspect prints, tolerating a crash and a truncated line. */
export function parseInspect(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return { ok: false, code: 'file-unreadable' }
  const line = text.split(/\r?\n/).filter(Boolean).pop()
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return { ok: false, code: 'file-unreadable' }
    return parsed
  } catch {
    return { ok: false, code: 'file-unreadable' }
  }
}

/** How long the current or last import has been running, in milliseconds. */
export function elapsedMs(job, nowMs) {
  if (!job?.startedAt) return 0
  const start = Date.parse(job.startedAt)
  if (Number.isNaN(start)) return 0
  const end = job.finishedAt ? Date.parse(job.finishedAt) : nowMs
  if (Number.isNaN(end)) return 0
  return Math.max(0, end - start)
}

/** Human-readable size for the file-source summary line. */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The absolute, forward-slash path of one article inside a base.
 *
 * Tool results print this path so the model can cite it as a link: the app
 * resolves a relative link against the session workspace, and the knowledge
 * base lives outside it, so a relative path opens nothing. Forward slashes keep
 * the link valid in markdown on Windows too.
 */
export function articlePath(root, rel) {
  const base = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const tail = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!base) return tail
  if (!tail) return base
  return `${base}/${tail}`
}

/**
 * The Confluence page address for one article id under a base URL.
 *
 * The derived search index has no `source_url` column, but every page has a
 * stable `viewpage.action?pageId=` address; printing it lets the model link the
 * original so the reader can open it in a browser. A file source has no base URL
 * and yields an empty string.
 */
export function pageUrl(baseUrl, id) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  const page = String(id || '').trim()
  if (!base || !page) return ''
  return `${base}/pages/viewpage.action?pageId=${encodeURIComponent(page)}`
}
