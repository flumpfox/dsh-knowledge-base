/**
 * knowledge-base: model-facing tools over the configured Confluence sources.
 *
 * Every source owns a separate knowledge base (its own `kb.sqlite` and articles),
 * so answers can cite which wiki a fact came from and two imports never mix. A
 * workspace may bind an ordered set of sources; with no binding the session uses
 * the default source. Tools carry provenance (updated / status / review_after)
 * in every result so the model sees freshness at the moment it uses a fact.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mergeHits, sourcesFor } from './lib/registry.js'
import { articlePath, pageUrl } from './lib/core.js'
import { loadSources, registerSettingsUi, translator, workspaceIdFor } from './server.js'

export const name = 'knowledge-base-tools'
// `webServer` is essential: the settings page cannot exist without its routes,
// and at startup the carrier may not be listening yet when this row activates.
export const inject = ['tools', 'webServer']

/**
 * Load the Host's tool builder.
 *
 * A bundle installed from a checkout is linked, not copied, so a plain
 * `import '@deepseek-ai/dsh-tools'` resolves from the checkout and fails at
 * startup (ERR_MODULE_NOT_FOUND) — the profile's copy is not on that path. Try
 * the package first (a copied install), then the running application's own copy
 * inside `app.asar`, which Electron's loader can import.
 */
async function loadDefineTool(ctx) {
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    if (typeof module.defineTool === 'function') return module.defineTool
  } catch {
    /* fall through to the application copy */
  }
  try {
    const resources = process.resourcesPath
    if (resources) {
      const href = pathToFileURL(join(resources, 'app.asar', 'dsh', 'node_modules',
        '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href
      const module = await import(href)
      if (typeof module.defineTool === 'function') return module.defineTool
    }
  } catch {
    /* reported below */
  }
  ctx.logger?.warn?.('knowledge-base: @deepseek-ai/dsh-tools is unavailable; the kb_* tools stay off')
  return null
}

const SKIP_DIRS = new Set(['raw', 'attachments', '.git', 'node_modules'])
const KB_ROOT_HINT = 'Sources and their bases are configured in Settings → Knowledge base'

/**
 * Language of the tool-call card for one call.
 *
 * The card header is the only part of a tool call a person reads, so it follows
 * the language chosen for the source the call targets (the same language the
 * settings page and the import reports use); the result text stays English,
 * because that is model-facing data. `registry` is injectable for tests.
 */
export function cardLocale(args = {}, registry = loadSources()) {
  const wanted = typeof args?.source === 'string' ? args.source : ''
  const source = registry.sources.find(item => item.id === wanted)
    || registry.sources.find(item => item.id === registry.defaultId)
    || registry.sources[0]
  return source?.locale === 'ru' ? 'ru' : 'en'
}

/** One translated tool-card title, resolved against the call's source language. */
export function cardTitle(key, args = {}) {
  return translator(cardLocale(args))(key)
}

/** Open one source's derived search index read-only. */
function openDb(root) {
  const path = join(root, 'kb.sqlite')
  if (!existsSync(path)) {
    throw new Error(`knowledge base index not found: ${path}. Import a source first.`)
  }
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return new DatabaseSync(path)
  }
}

/** Newest mtime among article files, to warn when the index lags behind the corpus. */
function newestArticle(root) {
  let newest = 0
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
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.md') || entry.name === 'INDEX.md' || entry.name === 'README.md') continue
      try {
        const mtime = statSync(full).mtimeMs
        if (mtime > newest) newest = mtime
      } catch {
        /* unreadable file is not fatal for a freshness hint */
      }
    }
  }
  walk(root, 0)
  return newest
}

function indexLag(root) {
  try {
    const dbTime = statSync(join(root, 'kb.sqlite')).mtimeMs
    return newestArticle(root) > dbTime + 1000
  } catch {
    return false
  }
}

/** Build an FTS5 MATCH expression: quoted prefix terms joined by AND. */
function matchExpression(query) {
  const terms = (query.match(/[\p{L}\p{N}_-]{2,}/gu) || []).slice(0, 8)
  if (terms.length === 0) throw new Error('query must contain at least one word of 2+ characters')
  return terms.map(t => `"${t.replace(/"/g, '')}"*`).join(' AND ')
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function ageMonths(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const then = Date.parse(iso + 'T00:00:00Z')
  if (Number.isNaN(then)) return null
  return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24 * 30.44))
}

/** Repeatable freshness verdict for one record. */
function freshness(updated, status, reviewAfter) {
  const months = ageMonths(updated)
  const flags = []
  if (status && status !== 'current') flags.push(status)
  if (reviewAfter && reviewAfter < today()) flags.push('review-due')
  if (months !== null && months >= 6) flags.push(`${months}m old`)
  if (months === null) flags.push('date unknown')
  return flags
}

/** The sources this call reads: the caller's workspace set, or the default. */
async function resolveBases(ctx, exec, only) {
  const registry = loadSources()
  const workspaceId = await workspaceIdFor(ctx, exec?.agent, exec?.signal)
  return sourcesFor(registry, { workspaceId, only: only || '' })
}

/** Run one read against one base, reporting failure as data instead of throwing. */
function attempt(base, run) {
  try {
    return { base, value: run() }
  } catch (error) {
    return { base, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function apply(ctx) {
  // The settings page works even when the tool builder cannot be loaded, so a
  // resolution problem degrades to "no kb_* tools" instead of a dead plugin.
  registerSettingsUi(ctx)
  const defineTool = await loadDefineTool(ctx)
  if (!defineTool) return

  ctx.tools.register(defineTool({
    name: 'kb_search',
    description:
      'Search the local Confluence knowledge bases (the wikis this deployment imported) and return article id, '
      + 'title, which source it came from, last-modified date, status and a snippet. Several sources may be in '
      + "play: the ones bound to the caller's workspace, otherwise the default one. Use it before answering any "
      + 'question about the documented systems instead of recalling from memory. Every hit carries its own date: '
      + 'a volatile fact (version, address, port, limit) from an article older than six months, or with status '
      + 'other than current, must be verified live or stated with its date. Cite the source id and source_updated '
      + 'in the answer. The `file=` line is an absolute path: cite it verbatim as a markdown link so the app can '
      + 'open the article (relative paths resolve against the workspace and open nothing). Every hit also prints '
      + 'the original page as `source=`; include it as a link so the reader can open the wiki page in a browser. '
      + KB_ROOT_HINT,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Two to four distinctive terms, Russian or English. Prefix matching is applied.',
      },
      space: { type: 'string', description: 'Restrict to a space name or its fragment.' },
      status: { type: 'string', enum: ['current', 'legacy', 'deprecated'], description: 'Restrict to one status.' },
      source: { type: 'string', description: 'Restrict to one source id (kb_status lists them).' },
      limit: { type: 'integer', description: 'How many hits to return (default 6, max 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                space: { type: 'string', required: true },
                source: { type: 'string', required: true },
                sourceName: { type: 'string', required: true },
                updated: { type: 'string', required: true },
                status: { type: 'string', required: true },
                flags: { type: 'array', required: true, items: { type: 'string' } },
                snippet: { type: 'string', required: true },
                path: { type: 'string', required: true },
                root: { type: 'string', required: true },
                sourceUrl: { type: 'string', required: true },
              },
            },
          },
          searched: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? `no matches in: ${value.searched.join(', ') || 'no configured source'}`
          : value.hits.map(h => `${h.title}  (${h.space}) · ${h.sourceName} [${h.source}]\n`
            + `  id=${h.id}  updated=${h.updated}  status=${h.status}`
            + (h.flags.length ? `  [${h.flags.join(', ')}]` : '')
            + `\n  ${h.snippet}\n  file=${articlePath(h.root, h.path)}`
            + (h.sourceUrl ? `\n  source=${h.sourceUrl}` : '')).join('\n\n') + (value.note ? `\n\n${value.note}` : ''),
      }],
    },
    async execute(args, exec) {
      const bases = await resolveBases(ctx, exec, args.source)
      if (bases.length === 0) throw new Error('no knowledge base source is configured; open Settings → Knowledge base')
      const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 20)
      const attempts = bases.map(base => attempt(base, () => {
        const db = openDb(base.root)
        try {
          let sql = 'SELECT m.id, m.title, m.space, m.path, m.source_updated, m.status, m.review_after,'
            + " snippet(fts, 2, '«', '»', ' … ', 22) AS snip"
            + ' FROM fts JOIN meta m ON m.id = fts.id WHERE fts MATCH ?'
          const params = [matchExpression(String(args.query))]
          if (args.space) {
            sql += ' AND m.space LIKE ?'
            params.push(`%${args.space}%`)
          }
          if (args.status) {
            sql += ' AND m.status = ?'
            params.push(String(args.status))
          }
          sql += ' ORDER BY bm25(fts, 8.0, 1.0) LIMIT ?'
          params.push(limit)
          return db.prepare(sql).all(...params).map(row => ({
            id: String(row.id),
            title: String(row.title || ''),
            space: String(row.space || ''),
            source: base.id,
            sourceName: base.name,
            updated: String(row.source_updated || 'unknown'),
            status: String(row.status || 'current'),
            flags: freshness(row.source_updated, row.status, row.review_after),
            snippet: String(row.snip || '').replace(/\s+/g, ' ').trim(),
            path: String(row.path || ''),
            root: base.root,
            sourceUrl: pageUrl(base.baseUrl, row.id),
          }))
        } finally {
          db.close()
        }
      }))
      const hits = mergeHits(attempts.filter(entry => entry.value).map(entry => ({ hits: entry.value })), limit)
      const problems = attempts.filter(entry => entry.error).map(entry => `${entry.base.id}: ${entry.error}`)
      const lagging = attempts.filter(entry => entry.value && indexLag(entry.base.root))
        .map(entry => entry.base.id)
      const notes = []
      if (problems.length) notes.push(`unavailable: ${problems.join('; ')}`)
      if (lagging.length) notes.push(`index lags behind the corpus in ${lagging.join(', ')}: run kb.py index`)
      return {
        hits,
        searched: bases.map(base => base.id),
        ...(notes.length ? { note: notes.join('. ') } : {}),
      }
    },
    presentCall: args => ({ card: 'generic', title: cardTitle('tool.search.title', args), kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_read',
    description:
      'Read one knowledge base article in full (frontmatter + body), by Confluence page id or title fragment, '
      + 'from whichever configured source holds it. Prefer this over trusting a snippet for procedural answers. '
      + 'The `file=` line is an absolute path: cite it verbatim as a markdown link so the app can open the article. '
      + 'The `source=` line is the original Confluence page; include it as a link for the reader. '
      + KB_ROOT_HINT,
    parameters: {
      id: { type: 'string', required: true, description: 'Page id (e.g. 27829466) or a distinctive title fragment.' },
      source: { type: 'string', description: 'Restrict to one source id (kb_status lists them).' },
      maxBytes: { type: 'integer', description: 'Truncate the body beyond this many bytes (default 40000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          space: { type: 'string', required: true },
          source: { type: 'string', required: true },
          sourceName: { type: 'string', required: true },
          updated: { type: 'string', required: true },
          status: { type: 'string', required: true },
          flags: { type: 'array', required: true, items: { type: 'string' } },
          sourceUrl: { type: 'string', required: true },
          path: { type: 'string', required: true },
          root: { type: 'string', required: true },
          body: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: `${v.title}  (${v.space}) · ${v.sourceName} [${v.source}]\nid=${v.id}  updated=${v.updated}  status=${v.status}`
          + (v.flags.length ? `  [${v.flags.join(', ')}]` : '')
          + `\nsource=${v.sourceUrl}\nfile=${articlePath(v.root, v.path)}\n\n${v.body}${v.truncated ? '\n\n[truncated by kb_read]' : ''}`,
      }],
    },
    async execute(args, exec) {
      const bases = await resolveBases(ctx, exec, args.source)
      if (bases.length === 0) throw new Error('no knowledge base source is configured; open Settings → Knowledge base')
      const cap = Math.min(Math.max(Number(args.maxBytes) || 40000, 2000), 200000)
      const wanted = String(args.id)
      for (const base of bases) {
        let row
        try {
          const db = openDb(base.root)
          try {
            row = db.prepare(
              'SELECT id, title, space, path, source_updated, status, review_after FROM meta WHERE id = ?'
              + ' UNION ALL SELECT id, title, space, path, source_updated, status, review_after FROM meta'
              + ' WHERE title LIKE ? LIMIT 1',
            ).get(wanted, `%${wanted}%`)
          } finally {
            db.close()
          }
        } catch {
          continue
        }
        if (!row) continue
        const raw = readFileSync(join(base.root, String(row.path)), 'utf8')
        const truncated = Buffer.byteLength(raw, 'utf8') > cap
        const body = truncated ? Buffer.from(raw, 'utf8').subarray(0, cap).toString('utf8') : raw
        // source_url lives in the markdown frontmatter, not in the derived index
        const url = /\nsource_url:\s*"?([^"\n]+)"?/.exec(raw)
        return {
          id: String(row.id),
          title: String(row.title || ''),
          space: String(row.space || ''),
          source: base.id,
          sourceName: base.name,
          updated: String(row.source_updated || 'unknown'),
          status: String(row.status || 'current'),
          flags: freshness(row.source_updated, row.status, row.review_after),
          sourceUrl: url ? url[1].trim() : '',
          path: String(row.path || ''),
          root: base.root,
          body,
          truncated,
        }
      }
      throw new Error(`no article matching ${JSON.stringify(wanted)} in: ${bases.map(base => base.id).join(', ')}`)
    },
    presentCall: args => ({ card: 'generic', title: cardTitle('tool.read.title', args), kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_review',
    description:
      'List knowledge base articles whose facts are due for re-verification: past review_after, status legacy or '
      + 'deprecated, or last modified more than six months ago — across every source this call reaches. Use it '
      + 'when the answer depends on volatile details, and offer the user the review queue instead of silently '
      + 'trusting old pages. ' + KB_ROOT_HINT,
    parameters: {
      limit: { type: 'integer', description: 'How many articles to list (default 10, max 50).' },
      months: { type: 'integer', description: 'Age threshold in months (default 6).' },
      source: { type: 'string', description: 'Restrict to one source id (kb_status lists them).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                source: { type: 'string', required: true },
                updated: { type: 'string', required: true },
                status: { type: 'string', required: true },
                reasons: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.total === 0
          ? 'nothing is due for review'
          : `${v.total} article(s) due for review\n\n` + v.items.map(i =>
            `${i.title}  [${i.updated}] ${i.reasons.join(', ')}\n  id=${i.id}  source=${i.source}  status=${i.status}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const bases = await resolveBases(ctx, exec, args.source)
      if (bases.length === 0) throw new Error('no knowledge base source is configured; open Settings → Knowledge base')
      const months = Math.max(1, Number(args.months) || 6)
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
      const items = []
      for (const base of bases) {
        let rows
        try {
          const db = openDb(base.root)
          try {
            rows = db.prepare('SELECT id, title, source_updated, status, review_after FROM meta').all()
          } finally {
            db.close()
          }
        } catch {
          continue
        }
        for (const row of rows) {
          const reasons = []
          if (row.status && row.status !== 'current') reasons.push(String(row.status))
          if (row.review_after && String(row.review_after) < today()) reasons.push(`review_after ${row.review_after}`)
          const age = ageMonths(String(row.source_updated || ''))
          if (age === null) reasons.push('date unknown')
          else if (age >= months) reasons.push(`${age} months old`)
          if (reasons.length) {
            items.push({
              id: String(row.id),
              title: String(row.title || ''),
              source: base.id,
              updated: String(row.source_updated || 'unknown'),
              status: String(row.status || 'current'),
              reasons,
            })
          }
        }
      }
      items.sort((a, b) => (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : 0))
      return { total: items.length, items: items.slice(0, limit) }
    },
    presentCall: args => ({ card: 'generic', title: cardTitle('tool.review.title', args), kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_status',
    description:
      'Report the configured knowledge base sources and their health: article count, spaces, statuses, last '
      + 'ingest and whether the search index lags behind the corpus. Also names the default source and which one '
      + 'the caller sees. Use it when the user asks whether the bases are current, or which sources exist. '
      + KB_ROOT_HINT,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bases: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                root: { type: 'string', required: true },
                isDefault: { type: 'boolean', required: true },
                reachable: { type: 'boolean', required: true },
                articles: { type: 'integer', required: true },
                spaces: { type: 'array', required: true, items: { type: 'string' } },
                statuses: { type: 'array', required: true, items: { type: 'string' } },
                lastIngest: { type: 'string', required: true },
                newestSource: { type: 'string', required: true },
                dueForReview: { type: 'integer', required: true },
                indexLag: { type: 'boolean', required: true },
              },
            },
          },
          reached: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, v) => [{
        type: 'text',
        text: v.bases.length ? v.bases.map(base => (base.reachable
          ? `${base.name} [${base.id}]${base.isDefault ? ' · default' : ''}${v.reached.includes(base.id) ? '' : ' · not reached'}\n`
            + `  articles: ${base.articles}\n  spaces: ${base.spaces.join(', ') || '-'}\n`
            + `  statuses: ${base.statuses.join(', ') || '-'}\n  last ingest: ${base.lastIngest}\n`
            + `  newest source date: ${base.newestSource}\n  due for review: ${base.dueForReview}\n`
            + `  root: ${base.root}${base.indexLag ? '\n  index lags behind the corpus: run kb.py index' : ''}`
          : `${base.name} [${base.id}]${base.isDefault ? ' · default' : ''} · no index yet\n  root: ${base.root}`))
          .join('\n\n')
          : 'No Confluence sources are configured. Add one in Settings → Knowledge base, or import a portable base archive.',
      }],
    },
    async execute(_args, exec) {
      const registry = loadSources()
      const workspaceId = await workspaceIdFor(ctx, exec?.agent, exec?.signal)
      const reached = sourcesFor(registry, { workspaceId }).map(base => base.id)
      const bases = registry.sources.map(source => {
        let rows = []
        let reachable = true
        try {
          const db = openDb(source.root)
          try {
            rows = db.prepare('SELECT space, status, source_updated, review_after FROM meta').all()
          } finally {
            db.close()
          }
        } catch {
          reachable = false
        }
        const spaces = [...new Set(rows.map(row => String(row.space || '?')))].sort()
        const statuses = [...new Set(rows.map(row => String(row.status || '?')))].sort()
        const dates = rows.map(row => String(row.source_updated || '')).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort()
        let lastIngest = 'unknown'
        try {
          const manifest = readFileSync(join(source.root, 'MANIFEST.jsonl'), 'utf8').split('\n').filter(Boolean)
          const ingests = manifest.map(line => {
            try {
              return String(JSON.parse(line).ingested || '')
            } catch {
              return ''
            }
          }).filter(Boolean).sort()
          if (ingests.length) lastIngest = ingests[ingests.length - 1]
        } catch {
          /* manifest is optional for status */
        }
        const due = rows.filter(row => (row.review_after && String(row.review_after) < today())
          || (row.status && row.status !== 'current')).length
        return {
          id: source.id,
          name: source.name,
          kind: source.source,
          root: source.root,
          isDefault: source.id === registry.defaultId,
          reachable,
          articles: rows.length,
          spaces,
          statuses,
          lastIngest,
          newestSource: dates.length ? dates[dates.length - 1] : 'unknown',
          dueForReview: due,
          indexLag: reachable ? indexLag(source.root) : false,
        }
      })
      return { bases, reached }
    },
    presentCall: () => ({ card: 'generic', title: cardTitle('tool.status.title'), kind: 'read', rawInput: {} }),
  }))
}
