import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ProgressState, articlePath, clampInt, dueMode, elapsedMs, formatBytes, interpolate,
  normalizeBaseUrl, pageUrl, parseImportSummary, parseInspect, parseProgressLine, validateBaseUrl,
} from '../lib/core.js'

test('progress lines follow the documented shape', () => {
  assert.deepEqual(parseProgressLine('PROGRESS 3/10 DBA'), { done: 3, total: 10, space: 'DBA' })
  assert.deepEqual(parseProgressLine('  PROGRESS 0/10  '), { done: 0, total: 10, space: '' })
  assert.deepEqual(parseProgressLine('PROGRESS 1/2 Projects with spaces'),
    { done: 1, total: 2, space: 'Projects with spaces' })
  assert.equal(parseProgressLine('import summary'), null)
  assert.equal(parseProgressLine('PROGRESS x/y DBA'), null)
  assert.equal(parseProgressLine(undefined), null)
})

test('a done count never exceeds its total, and an unknown total stays unknown', () => {
  assert.deepEqual(parseProgressLine('PROGRESS 12/10 DBA'), { done: 10, total: 10, space: 'DBA' })
  assert.equal(parseProgressLine('PROGRESS 4/0 DBA').done, 4)
})

test('ProgressState keeps the latest line and reports a nullable percent', () => {
  const progress = new ProgressState()
  assert.equal(progress.push('PROGRESS 1/4 OPS'), true)
  assert.equal(progress.push('not a progress line'), false)
  const half = progress.push('PROGRESS 2/4 OPS') && progress.snapshot()
  assert.deepEqual(half, { done: 2, total: 4, space: 'OPS', percent: 50 })

  const unknown = new ProgressState()
  unknown.push('PROGRESS 7/0 OPS')
  assert.deepEqual(unknown.snapshot(), { done: 7, total: 0, space: 'OPS', percent: null })
})

test('the import summary is read from kb.py stdout', () => {
  const stats = parseImportSummary([
    'import summary',
    '  added      3',
    '  changed    1',
    '  unchanged  0',
    '  deprecated 2',
    '  skipped    4',
    '  filtered   5',
    '  kb         C:\\kb',
    '  skipped files:',
    '    - x.html: no content',
  ])
  assert.deepEqual(stats, { added: 3, changed: 1, unchanged: 0, deprecated: 2, skipped: 4, filtered: 5 })
  assert.deepEqual(parseImportSummary([]), { added: 0, changed: 0, unchanged: 0, deprecated: 0, skipped: 0, filtered: 0 })
  assert.equal(parseImportSummary(['  added      7']).added, 7)
})

test('base URL normalization keeps the context path and rejects non-http', () => {
  assert.equal(normalizeBaseUrl('  https://wiki.example.local///  '), 'https://wiki.example.local')
  assert.deepEqual(validateBaseUrl('https://wiki.example.local/confluence/'),
    { ok: true, value: 'https://wiki.example.local/confluence', code: '' })
  assert.deepEqual(validateBaseUrl('  '), { ok: false, value: '', code: 'url.empty' })
  assert.equal(validateBaseUrl('not a url').code, 'url.invalid')
  assert.equal(validateBaseUrl('ftp://wiki.example.local').code, 'url.scheme')
  assert.equal(validateBaseUrl('https://wiki.example.local').ok, true)
})

test('numeric fields are clamped into their allowed range', () => {
  assert.equal(clampInt('7', 1, 3650, 30), 7)
  assert.equal(clampInt('0', 1, 3650, 30), 1)
  assert.equal(clampInt('99999', 1, 3650, 30), 3650)
  assert.equal(clampInt('abc', 1, 3650, 30), 30)
  assert.equal(clampInt(undefined, 1, 3650, 30), 30)
})

test('schedule arithmetic answers "full", "incremental", or nothing', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const days = n => new Date(now - n * 86_400_000).toISOString()
  const api = {
    source: 'api',
    baseUrl: 'https://wiki.example.local',
    schedule: { incrementalDays: 7, fullDays: 30 },
  }
  // Nothing recorded yet: the first run must be a full pass.
  assert.equal(dueMode(api, now), 'full')
  assert.equal(dueMode({ ...api, lastSuccess: days(1), lastFull: days(1) }, now), '')
  assert.equal(dueMode({ ...api, lastSuccess: days(8), lastFull: days(8) }, now), 'incremental')
  assert.equal(dueMode({ ...api, lastSuccess: days(2), lastFull: days(31) }, now), 'full')
  // An unconfigured source never schedules anything.
  assert.equal(dueMode({ ...api, baseUrl: '' }, now), '')
  // The file source has no --since: a due run is always one full pass.
  const file = {
    source: 'file',
    filePath: 'C:\\exports\\proj.zip',
    schedule: { incrementalDays: 7, fullDays: 30 },
  }
  assert.equal(dueMode({ ...file, lastSuccess: days(1) }, now), '')
  assert.equal(dueMode({ ...file, lastSuccess: days(9) }, now), 'full')
  assert.equal(dueMode({ ...file, lastSuccess: '', lastFull: '' }, now), 'full')
})

test('interpolation leaves unknown placeholders alone', () => {
  assert.equal(interpolate('{done} of {total}', { done: 3, total: 9 }), '3 of 9')
  assert.equal(interpolate('{done} of {total}', { done: 3 }), '3 of {total}')
  assert.equal(interpolate('no placeholders'), 'no placeholders')
})

test('inspect output is read defensively', () => {
  assert.deepEqual(parseInspect('{"ok":true,"pages":3}'), { ok: true, pages: 3 })
  assert.deepEqual(parseInspect('noise\n{"ok":false,"code":"file-not-zip"}'),
    { ok: false, code: 'file-not-zip' })
  assert.deepEqual(parseInspect(''), { ok: false, code: 'file-unreadable' })
  assert.deepEqual(parseInspect('not json'), { ok: false, code: 'file-unreadable' })
})

test('elapsed time and byte formatting', () => {
  const job = { startedAt: '2026-11-18T12:00:00.000Z', finishedAt: '2026-11-18T12:00:42.000Z' }
  assert.equal(elapsedMs(job, Date.parse('2026-11-18T13:00:00Z')), 42_000)
  assert.equal(elapsedMs({ startedAt: '2026-11-18T12:00:00.000Z' }, Date.parse('2026-11-18T12:00:05Z')), 5_000)
  assert.equal(elapsedMs(null, 0), 0)
  assert.equal(formatBytes(0), '')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 kB')
  assert.equal(formatBytes(7_244_680), '6.9 MB')
})

test('an article path is absolute and uses forward slashes', () => {
  // The app resolves a relative link against the session workspace, and the base
  // lives outside it: only an absolute path opens the article in the sidebar.
  assert.equal(articlePath('C:\\Users\\user\\.dsh\\kb\\confluence', 'projects/a--1.md'),
    'C:/Users/user/.dsh/kb/confluence/projects/a--1.md')
  assert.equal(articlePath('C:/kb/', '/projects/a--1.md'), 'C:/kb/projects/a--1.md')
  assert.equal(articlePath('C:/kb', ''), 'C:/kb')
  assert.equal(articlePath('', 'projects/a--1.md'), 'projects/a--1.md')
  assert.equal(articlePath('C:/kb', 'projects\\a--1.md'), 'C:/kb/projects/a--1.md')
})

test('a page URL points at the original Confluence page', () => {
  assert.equal(pageUrl('https://confluence.example.local', '27823229'),
    'https://confluence.example.local/pages/viewpage.action?pageId=27823229')
  assert.equal(pageUrl('https://wiki.example.local/confluence/', '42'),
    'https://wiki.example.local/confluence/pages/viewpage.action?pageId=42')
  assert.equal(pageUrl('', '42'), '', 'a file source has no page URL')
  assert.equal(pageUrl('http://kb.local', ''), '')
})
