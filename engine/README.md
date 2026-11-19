# kb.py — the engine

Russian translation: [README.ru.md](README.ru.md).

Confluence → markdown knowledge base with provenance. This is the CLI half: the DSH plugin
(`../plugin`) drives it, the skill (`../skill`) wraps it for `~/.dsh/skills`, and both read the
same corpus layout.

The point is not "convert HTML to markdown". The point is that wiki content silently goes stale,
so every article carries where it came from, when it changed, and whether it is still current.

```
engine/
  kb.py                  the CLI (stdlib only, no dependencies)
  tests/run_tests.py     17 end-to-end cases
  tests/make_fixture.py  synthetic exports (incl. a ':' attachment and duplicate ids)
  tests/mock_confluence.py  Confluence 8.x REST mock (Bearer/Basic, paging, CQL, delay)
```

## Commands

```
kb.py [--version]
kb.py [--kb DIR] import  --zip FILE [--base-url URL] [--spaces KEYS] [--progress] [--dry-run]
kb.py [--kb DIR] inspect --zip FILE [--json]
kb.py [--kb DIR] fetch   --url URL (--token T | --user U --password P) [--spaces KEYS]
                         [--space-type global|personal|all] [--since YYYY-MM-DD]
                         [--no-attachments] [--save-zip FILE] [--list-spaces]
                         [--progress] [--insecure] [--dry-run]
kb.py [--kb DIR] index | search "terms" [-n N] [--space S] [--status S] | get ID
                 | audit [--months N] [--json] | stats
                 | pack --out FILE [--meta FILE] [--progress] [--json]
                 | unpack --archive FILE [--check] [--json]
```

`--kb` defaults to `$KB_HOME`; otherwise the engine reads `$KB_DIR` (or `~/.dsh/kb`) `knowledge-sources.json` and uses the default source directory; with neither it says that no base is configured. `--version` prints the engine version.

- **`import`** is a diff, not a rewrite: unchanged bodies stay byte-identical, changed ones are
  regenerated, pages missing from the archive become tombstones. `--spaces` narrows a
  multi-space archive while the pages of other spaces still count as present, so narrowing never
  tombstones them.
- **`inspect`** validates an archive without touching a base: it must exist, be non-empty, be a
  real zip, and contain page HTML. It reports the size, the page-file count, and the spaces read
  from each `index.html`; failures carry stable codes (`file-missing`, `file-empty`,
  `file-not-zip`, `file-no-pages`, `file-unreadable`).
- **`fetch`** lists every visible space (`/rest/api/space`), walks each space's pages
  (`/rest/api/content` with `expand=body.view,version,space`, or a CQL `lastmodified >` search
  with `--since`), downloads attachments, writes an export-shaped zip under `raw/`, and runs the
  ordinary importer on it — so an API import and a file import into the same base diff against
  each other. `body.view` is Confluence's own rendered HTML, so macro handling matches the zip
  path. Requests are sequential with exponential backoff on 429/5xx.
- **`--progress`** (import and fetch) prints `PROGRESS <done>/<total> <space>` on stderr, one
  line per page; `total` is the archive page count or the summed `totalSize` of the CQL page
  search. Confluence Server omits `totalSize` on the plain `/rest/api/content` listing, so `fetch`
  asks `/rest/api/content/search` for the count and keeps the plain listing only as a fallback.
  The DSH settings page parses exactly this format.
- **`pack`** writes a portable archive of one base: articles, `MANIFEST.jsonl`, `kb.sqlite`, attachments, and `knowledge-base.json` with `"format": "dsh-knowledge-base-base"` and the public source metadata passed by `--meta` (name, base URL, spaces; never credentials). `raw/` and the old `connection.json` are left out. `--progress` prints `PACK <done>/<total>` in bytes on stderr.
- **`unpack`** validates and restores such an archive; `--check` validates without writing. Archives carrying the earlier `confluence-kb.json` / `dsh-confluence-kb-base` marker are still accepted, and unpacking refuses path traversal, a foreign format and a missing marker.

## Layout of a base

```
<KB>/
  INDEX.md                     generated contents, by space
  MANIFEST.jsonl               one row per page: id, hash, dates, signals
  kb.sqlite                    FTS5 index (derived: delete freely, rebuilt on demand)
  <space>/<title-slug>--<id>.md
  attachments/<pageId>/...
  raw/<stamp>-<ziphash>/       extracted export the import came from
```

Article frontmatter:

```yaml
id: 101                     # Confluence page id (stable across renames)
title: Настройка Patroni в двух ЦОД
space: DBA
source_url: https://confluence.../pages/viewpage.action?pageId=101
source_updated: 2025-03-14  # date printed inside the page, or unknown
ingested: 2026-11-18        # when this export was imported
status: current             # current | legacy | deprecated
content_hash: 139d4d320b32b134
review_after: 2025-09-10    # source date + 6 months, not import date + 6 months
```

## Staleness model

1. **Two clocks, kept apart.** `source_updated` is the page's own date; `ingested` is the export
   date. A zip timestamp is never used as the page date — that would launder old content into
   looking fresh.
2. **`review_after` counts from the source date**, so an old page is flagged immediately instead
   of receiving a fresh six-month lease.
3. **Re-import is a diff, not a rewrite.** Unchanged bodies stay byte-identical (hand notes
   survive), changed bodies are regenerated, removed pages become tombstones
   (`status: deprecated`) rather than disappearing.
4. **`audit` produces a review queue**, sorted by staleness, with the reason per article and
   "signals" — counts of IP addresses, versions, paths, URLs — which rank how much a page is
   likely to rot.
5. **The agent's rule lives in `../skill/SKILL.md`**: volatile facts from an old article are
   either verified live or explicitly dated, never asserted as current.

## Files on disk that Confluence did not name for you

- **Attachment titles are not file names.** `image 21:0:24.png` is legal in Confluence and
  refused by Windows. Every path component is made portable (forbidden characters → `_`,
  trailing dots dropped, reserved device names prefixed, length capped) when an archive is
  extracted *and* when an article links to an attachment, so the link and the file agree.
- **One file per page id.** A base accumulates files from several imports and an id can arrive on
  two files (an older import with another title, an export that repeats an id). An import removes
  the stale twin and reports it as `duplicates`; the index keeps one row per id and warns about
  anything left over instead of failing.
- **Empty pages are skipped** ("no content"): a page with no body stays in the wiki, not in the
  base.
- Extraction escapes the Windows 260-character path limit, and a download URL a server left with
  a raw space is percent-encoded before the request.

## Tests

```powershell
python engine\tests\run_tests.py
```

17 cases against synthetic exports and a Confluence mock: parsing, noise removal, macros, tables,
idempotent reimport, annotation survival, changed/dropped pages, search, audit, legacy export
without `ajs-*` metadata, windows-1251, the REST mock (Bearer and Basic, paging, CQL, attachments),
`--progress` on both paths, `inspect` and its error codes, `--spaces` narrowing, portable file
names, duplicate page ids, and the skill copy staying identical to this file.
