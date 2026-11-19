/**
 * Pure registry logic for multiple Confluence sources.
 *
 * One registry file lists every source (each with its own knowledge-base root),
 * which one is the default, and which ordered set of sources a workspace gets.
 * Nothing here touches the filesystem: the Host passes paths in and writes the
 * result out, so every rule below is testable with plain objects.
 *
 * A source is "one wiki → one base": its own `kb.sqlite`, its own manifest, its
 * own schedule and its own job. Two servers never share a base, so an import
 * from one can never tombstone pages of the other.
 */

export const REGISTRY_VERSION = 2

/** A brand-new source with every field the Host and the page expect. */
export function blankSource(id, name = '') {
  return {
    id,
    name: name || id,
    type: 'confluence',
    source: 'api',
    auth: 'bearer',
    baseUrl: '',
    filePath: '',
    spaces: [],
    spacesAll: false,
    root: '',
    schedule: { incrementalDays: 7, fullDays: 30 },
    lastSuccess: '',
    lastFull: '',
    lastError: '',
    lastRun: null,
    taskId: '',
    locale: 'en',
    // Set when the base arrived as an archive: its base URL is part of the
    // imported content and must never be repointed at another server.
    imported: false,
  }
}

const TEXT_FIELDS = ['name', 'type', 'source', 'auth', 'baseUrl', 'filePath', 'root', 'lastSuccess',
  'lastFull', 'lastError', 'taskId', 'locale']
const ONE_OF = {
  type: ['confluence'],
  source: ['api', 'file'],
  auth: ['bearer', 'basic'],
}

/** A conservative id: letters, digits, and dashes; never empty, never a path. */
export function slugify(text) {
  const base = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'source'
}

/** Directory and file names the knowledge-base home already uses. */
const RESERVED_IDS = new Set(['exports', 'knowledge-sources'])

/** A fresh id that no existing source uses and no service name shadows. */
export function uniqueId(candidate, taken) {
  const used = new Set(taken)
  const slug = slugify(candidate)
  const base = RESERVED_IDS.has(slug) ? `${slug}-source` : slug
  if (!used.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const next = `${base}-${index}`
    if (!used.has(next)) return next
  }
  return `${base}-${Date.now()}`
}

/** Coerce one stored/patched source, keeping unknown fields out and types right. */
export function normalizeSource(input, fallbackId = 'source') {
  const id = String(input?.id ?? fallbackId)
  const source = blankSource(id, String(input?.name ?? ''))
  source.id = id
  for (const field of TEXT_FIELDS) {
    const value = input?.[field]
    source[field] = value === undefined || value === null ? '' : String(value)
  }
  for (const [field, allowed] of Object.entries(ONE_OF)) {
    if (!allowed.includes(source[field])) source[field] = allowed[0]
  }
  source.name = source.name.trim() || id
  source.spaces = Array.isArray(input?.spaces) ? input.spaces.map(String).slice(0, 2000) : []
  source.spacesAll = Boolean(input?.spacesAll)
  const schedule = input?.schedule || {}
  source.schedule = {
    incrementalDays: clampDays(schedule.incrementalDays, 7),
    fullDays: clampDays(schedule.fullDays, 30),
  }
  source.lastRun = input?.lastRun && typeof input.lastRun === 'object' ? input.lastRun : null
  source.imported = Boolean(input?.imported)
  return source
}

/**
 * Whether a source's base URL is frozen.
 *
 * An imported base carries the URL its articles were fetched from, so it is
 * frozen for good. A source that has completed at least one import is frozen
 * while that data exists: editing the URL would make the local base claim a
 * server that never hosted it. Clearing the base of an ordinary source lifts
 * the freeze; an imported one stays frozen.
 */
export function urlLockedFor(source) {
  if (source?.imported) return true
  // A file source has no base URL to freeze; the flag matters once it is a
  // server source whose articles were fetched from that server.
  return source?.source === 'api' && Boolean(source?.lastSuccess)
}

function clampDays(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), 1), 3650)
}

/**
 * Turn any stored shape into a usable registry.
 *
 * A missing registry and an empty one both mean "no sources yet": the first source
 * is created by the user, with the id they choose, so nothing is seeded here.
 * Version 1 kept a single connection in `connection.json`; if that file is still
 * around it becomes one source, keeping its articles under `<home>/<id>`.
 */
export function normalizeRegistry(raw, { home = '', legacyV1 = null } = {}) {
  const registry = {
    version: REGISTRY_VERSION,
    defaultId: '',
    sources: [],
    workspaces: {},
  }
  const stored = raw && typeof raw === 'object' ? raw : {}
  const list = Array.isArray(stored.sources) ? stored.sources : []
  for (const entry of list) {
    const source = normalizeSource(entry, entry?.id || 'source')
    if (!source.root) source.root = home ? `${home}/${source.id}` : ''
    if (!registry.sources.some(existing => existing.id === source.id)) registry.sources.push(source)
  }

  if (registry.sources.length === 0 && legacyV1 && typeof legacyV1 === 'object') {
    const legacyId = slugify(legacyV1.name || 'default')
    const migrated = normalizeSource({
      id: legacyId,
      name: legacyV1.name || 'default',
      source: legacyV1.source,
      auth: legacyV1.auth,
      baseUrl: legacyV1.baseUrl,
      filePath: legacyV1.filePath,
      spaces: legacyV1.spaces,
      spacesAll: legacyV1.spacesAll,
      schedule: legacyV1.schedule,
      lastSuccess: legacyV1.lastSuccess,
      lastFull: legacyV1.lastFull,
      lastError: legacyV1.lastError,
      lastRun: legacyV1.lastRun,
      taskId: legacyV1.taskId,
      locale: legacyV1.locale,
      root: home ? `${home}/${legacyId}` : '',
    })
    registry.sources.push(migrated)
    registry.defaultId = migrated.id
  }

  registry.defaultId = registry.sources.length === 0
    ? ''
    : (registry.sources.some(source => source.id === stored.defaultId)
      ? stored.defaultId
      : registry.sources[0].id)

  const workspaces = stored.workspaces && typeof stored.workspaces === 'object' ? stored.workspaces : {}
  const known = new Set(registry.sources.map(source => source.id))
  for (const [workspaceId, ids] of Object.entries(workspaces)) {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(id => known.has(id))
    if (list.length) registry.workspaces[String(workspaceId)] = [...new Set(list)]
  }
  return registry
}

/** Ordered sources a workspace uses; falls back to the default source alone. */
export function sourceIdsFor(registry, workspaceId) {
  const known = new Set(registry.sources.map(source => source.id))
  const bound = workspaceId ? registry.workspaces?.[String(workspaceId)] : undefined
  const chosen = (bound || []).filter(id => known.has(id))
  if (chosen.length) return chosen
  if (known.has(registry.defaultId)) return [registry.defaultId]
  return registry.sources.length ? [registry.sources[0].id] : []
}

/** The sources a query should read, in order, restricted by an explicit id. */
export function sourcesFor(registry, { workspaceId = '', only = '' } = {}) {
  const byId = new Map(registry.sources.map(source => [source.id, source]))
  const ids = only ? [String(only)] : sourceIdsFor(registry, workspaceId)
  return ids.map(id => byId.get(id)).filter(Boolean)
}

/**
 * Merge per-source search results into one ranked list.
 *
 * BM25 values are only comparable inside one index, so the merge keeps each
 * base's own order and interleaves: the first hit of every source, then the
 * second, and so on. That is stable, explainable, and never lets a large base
 * bury a small one entirely.
 */
export function mergeHits(perSource, limit) {
  const lists = perSource.map(entry => entry.hits || [])
  const merged = []
  const depth = Math.max(0, ...lists.map(hits => hits.length))
  for (let index = 0; index < depth; index += 1) {
    for (let position = 0; position < lists.length; position += 1) {
      const hit = lists[position][index]
      if (hit) merged.push(hit)
      if (merged.length >= limit) return merged
    }
  }
  return merged.slice(0, limit)
}
