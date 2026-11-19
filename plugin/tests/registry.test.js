import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blankSource, mergeHits, normalizeRegistry, normalizeSource, slugify, sourceIdsFor, sourcesFor,
  uniqueId, urlLockedFor,
} from '../lib/registry.js'

test('source ids are safe, unique, and derived from the name', () => {
  assert.equal(slugify('PROJ wiki'), 'proj-wiki')
  assert.equal(slugify('  Вики 3A  '), '3a', 'non-latin letters are dropped, not transliterated')
  assert.equal(slugify('Вики'), 'source', 'a name with no latin or digits still yields an id')
  assert.equal(slugify(''), 'source')
  assert.equal(uniqueId('proj', []), 'proj')
  assert.equal(uniqueId('proj', ['proj']), 'proj-2')
  assert.equal(uniqueId('proj', ['proj', 'proj-2']), 'proj-3')
})

test('one source keeps every field the Host and the page use', () => {
  const source = normalizeSource({
    id: 'proj',
    name: '  PROJ  ',
    source: 'weird',
    auth: 'nope',
    spaces: ['A', 2],
    spacesAll: 'yes',
    schedule: { incrementalDays: 0, fullDays: '9999' },
    root: 'C:/kb/proj',
    extra: 'ignored',
  })
  assert.equal(source.id, 'proj')
  assert.equal(source.name, 'PROJ')
  assert.equal(source.source, 'api', 'unknown kinds fall back to the first allowed one')
  assert.equal(source.auth, 'bearer')
  assert.deepEqual(source.spaces, ['A', '2'])
  assert.equal(source.spacesAll, true)
  assert.deepEqual(source.schedule, { incrementalDays: 1, fullDays: 3650 })
  assert.equal(source.root, 'C:/kb/proj')
  assert.equal('extra' in source, false)
  assert.equal(source.taskId, '')
  assert.equal(source.type, 'confluence')
})

test('a v1 single connection becomes the default source and keeps its root', () => {
  const registry = normalizeRegistry(null, {
    home: 'C:/Users/x/.dsh/kb',
    legacyV1: {
      name: 'PROJ export',
      source: 'file',
      filePath: 'C:/exports/proj.zip',
      spacesAll: true,
      lastSuccess: '2026-11-18T10:00:00.000Z',
      locale: 'ru',
    },
  })
  assert.equal(registry.version, 2)
  assert.equal(registry.sources.length, 1)
  const [source] = registry.sources
  assert.equal(source.id, 'proj-export')
  assert.equal(source.source, 'file')
  assert.equal(source.filePath, 'C:/exports/proj.zip')
  assert.equal(source.spacesAll, true)
  assert.equal(source.lastSuccess, '2026-11-18T10:00:00.000Z')
  assert.equal(source.locale, 'ru')
  assert.equal(source.root, 'C:/Users/x/.dsh/kb/proj-export', 'the migrated source keeps its articles under the home')
  assert.equal(registry.defaultId, 'proj-export')
})

test('a missing registry yields no sources: the first one is created by the user', () => {
  const registry = normalizeRegistry(null, { home: 'C:/kb' })
  assert.deepEqual(registry.sources, [])
  assert.equal(registry.defaultId, '')
})

test('a stored default that no longer exists falls back to the first source', () => {
  const registry = normalizeRegistry({
    defaultId: 'gone',
    sources: [blankSource('a'), blankSource('b')],
  }, { home: 'C:/kb' })
  assert.equal(registry.defaultId, 'a')
  assert.deepEqual(registry.sources.map(source => source.root), ['C:/kb/a', 'C:/kb/b'])
})

test('workspace sets resolve to known sources and fall back to the default', () => {
  const registry = normalizeRegistry({
    defaultId: 'a',
    sources: [blankSource('a'), blankSource('b'), blankSource('c')],
    workspaces: { ws1: ['c', 'gone', 'b'], ws2: [], ws3: ['gone'] },
  }, { home: 'C:/kb' })

  assert.deepEqual(registry.workspaces, { ws1: ['c', 'b'] }, 'unknown ids are dropped')
  assert.deepEqual(sourceIdsFor(registry, 'ws1'), ['c', 'b'])
  assert.deepEqual(sourceIdsFor(registry, 'ws2'), ['a'], 'an empty set means the default')
  assert.deepEqual(sourceIdsFor(registry, 'ws3'), ['a'], 'a set of only unknown ids means the default')
  assert.deepEqual(sourceIdsFor(registry, 'unknown'), ['a'])
  assert.deepEqual(sourceIdsFor(registry, ''), ['a'])
})

test('a tool call can restrict itself to one source', () => {
  const registry = normalizeRegistry({
    defaultId: 'a',
    sources: [blankSource('a', 'Alpha'), blankSource('b', 'Beta')],
    workspaces: { ws1: ['b'] },
  }, { home: 'C:/kb' })

  assert.deepEqual(sourcesFor(registry, { workspaceId: 'ws1' }).map(source => source.id), ['b'])
  assert.deepEqual(sourcesFor(registry, { workspaceId: 'ws1', only: 'a' }).map(source => source.id), ['a'])
  assert.deepEqual(sourcesFor(registry, { only: 'gone' }), [], 'an unknown id matches nothing')
})

test('merged results interleave sources instead of letting one base bury another', () => {
  const a = { hits: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }
  const b = { hits: [{ id: 'b1' }] }
  assert.deepEqual(mergeHits([a, b], 10).map(hit => hit.id), ['a1', 'b1', 'a2', 'a3'])
  assert.deepEqual(mergeHits([a, b], 2).map(hit => hit.id), ['a1', 'b1'])
  assert.deepEqual(mergeHits([], 5), [])
  assert.deepEqual(mergeHits([{ hits: [] }, { hits: [] }], 5), [])
})

test('a base URL is frozen by an import and permanently by an imported base', () => {
  const fresh = normalizeSource(blankSource('a', 'Alpha'))
  assert.equal(urlLockedFor(fresh), false, 'a new source may be pointed anywhere')

  const imported = normalizeSource({ ...blankSource('b', 'Beta'), lastSuccess: '2026-01-01T00:00:00Z' })
  assert.equal(urlLockedFor(imported), true, 'data exists, so the URL describes it')

  const cleared = normalizeSource({ ...imported, lastSuccess: '', lastFull: '' })
  assert.equal(urlLockedFor(cleared), false, 'clearing the files of an ordinary source unlocks it')

  const portable = normalizeSource({ ...blankSource('c', 'Gamma'), imported: true, lastSuccess: '' })
  assert.equal(urlLockedFor(portable), true, 'an archive keeps its origin even when cleared')
  const fileSource = normalizeSource({
    ...blankSource('d', 'Delta'), source: 'file', lastSuccess: '2026-01-01T00:00:00Z',
  })
  assert.equal(urlLockedFor(fileSource), false, 'a file source has no URL to freeze')
  assert.equal(normalizeSource({ imported: 'yes' }).imported, true, 'the flag survives storage')
  assert.equal(normalizeSource({}).imported, false, 'and defaults to false')
})

test('an existing registry with no sources stays empty', () => {
  // A user may delete every source; the file must not resurrect a default one.
  const empty = normalizeRegistry({ version: 2, defaultId: '', sources: [], workspaces: {} },
    { home: 'C:/kb' })
  assert.deepEqual(empty.sources, [])
  assert.equal(empty.defaultId, '')
  assert.deepEqual(sourceIdsFor(empty, ''), [])

  // A missing registry is the same empty state: nothing is seeded.
  const missing = normalizeRegistry(null, { home: 'C:/kb' })
  assert.deepEqual(missing.sources, [])
  assert.equal(missing.defaultId, '')
})

test('service names are not used as source ids', () => {
  assert.equal(uniqueId('exports', []), 'exports-source')
  assert.equal(uniqueId('knowledge-sources', []), 'knowledge-sources-source')
  assert.equal(uniqueId('exports', ['exports-source']), 'exports-source-2')
})
