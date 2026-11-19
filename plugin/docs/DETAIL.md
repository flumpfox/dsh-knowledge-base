# Knowledge base

Builds local knowledge bases for the agent from external knowledge sources and gives it four tools over them. Several sources can be configured, each with its own base. Confluence Server / Data Center — over its REST API or from an HTML export zip on disk — is supported now; Jira, Obsidian and other sources are planned. The corpus (markdown articles plus `kb.sqlite`) is produced by `kb.py`; the plugin reads it and drives imports.

## What the agent gets

| Tool | Purpose |
|---|---|
| `kb_search` | full-text search over titles and bodies, ranked, with a snippet |
| `kb_read` | one article in full, by page id or title fragment |
| `kb_review` | the queue of articles due for re-verification |
| `kb_status` | article count, spaces, statuses, last ingest, index lag |

Every result carries `updated` (the source page's own last-modified date), `status`
(`current` / `legacy` / `deprecated`) and computed flags such as `review-due` or `8m old`.
Freshness therefore travels with the fact: the agent sees it at the moment of use.
`kb_search` and `kb_read` print `file=` as an **absolute** path. A relative link is resolved by the
app against the session workspace, and the base lives outside it, so the side panel would answer
"file not found"; the absolute path opens the article there, and the tool descriptions and the
skill tell the agent to cite it verbatim as a markdown link. Both also print `source=` — the
original Confluence page, computed from the source's base URL and the page id (a file source has
none). DSH opens chat links where its own setting says — Settings → General → “Open chat links in”:
the in-app sidebar or the default browser — so the primary source is one click away in whichever
place the reader prefers.

## Settings → Knowledge base

The section sits after Plugins. It configures one source at a time:

- **Connect to a server** — the base URL plus one of two authentication modes:
  - **Personal access token** (`Authorization: Bearer`), for Confluence Data Center
    installations that issue tokens.
  - **User and password** (HTTP Basic), which every Confluence Server accepts.

  "Check connection" signs the request, asks the server who it is, and then lists the
  spaces that identity can read. When the server answers as an anonymous user, the page
  says the credentials were not accepted instead of showing an empty list — a Confluence
  Server that does not support tokens ignores the `Authorization: Bearer` header entirely
  and answers `200` with no spaces, which would otherwise look like an empty wiki. Both
  secrets live in the DSH credential store and are never returned to the page; the token
  and the password reach `kb.py` through the process environment, never the command line.
- **Export file** — the full path of a zip produced by Confluence → Space → Export → HTML.
  "Check file" validates it through `kb.py inspect`: it must exist, be non-empty, be a real zip,
  and contain page HTML. The page shows the file size, the number of candidate pages, and the
  spaces found in the archive's own `index.html`, so the space picker works the same way in both
  modes. No token is involved and none is requested.

The space list has a filter over key and name, "select all filtered", "clear selection", a
selected/total counter, and the selection is saved. "All spaces, including new ones" imports the
whole server; the list stays usable and the note explains that it no longer limits the run.

The schedule stores two intervals: an incremental pass (only pages changed since the last
success) and a full pass (which also notices deletions). The Host runs them on its own hourly
timer **while the DSH app is running**: no conversation has to be open, but a closed app imports
nothing. With a file source every run re-imports the same path, which suits an export another tool
drops there.

## Moving a base between machines

Three actions work on the base itself, below the source settings:

- **Export base** asks where to save it: a folder — “Browse…” opens the system folder chooser, and a
  typed absolute path works too — and a file name, with `.zip` added when it is missing. An
  existing file is not replaced silently: the page asks with “Replace” and “Cancel”, and only
  “Replace” allows the overwrite — the pack writes a temporary file and renames it, so a failed run
  leaves the old archive untouched. Packing runs in the background: the page shows bytes done of
  total, a bar and a percentage, and “Cancel packing” stops the run and removes the partial file.
  When it finishes the page reports the full path, the article count and the size, and
  “Open folder” reveals that file in the system file manager (Explorer with the archive selected on
  Windows, Finder on macOS, the containing folder on Linux). Only the finished export's own path is
  revealed — the route takes no path from the page — and a file moved away since the run is
  reported instead of opening something else. The archive
  carries the whole corpus — articles, `MANIFEST.jsonl`, `kb.sqlite`, attachments — plus
  `knowledge-base.json` with the source name, kind, **base URL**, spaces, schedule and locale. It
  never contains credentials: they live in the DSH credential store, not in the base. `raw/` (the
  extracted export used as import input) and the v1 `connection.json` are left out; both are
  recreated when needed.
- **Import base** restores such an archive as a new source (`kb.py unpack`), with a fresh id and
  its own directory. Nothing is fetched from Confluence, so it works on a machine that cannot
  reach the server; the credentials still have to be entered there. A later import from the same
  base URL works normally — the engine diffs against the restored manifest, so it continues from
  the state the other machine left.
- **Delete the base files** removes the articles, index and attachments of one source while
  keeping its settings and credentials; the base URL unlocks. Deleting a source removes both the
  source and its files, and works even for the last source: the page then shows an empty state
  with "add source" and "import base".

A base URL is frozen once the source has imported from it: the articles carry that URL in their
front matter, so pointing the source elsewhere would make the local corpus claim a server that
never hosted it. The field is read-only with a hint; the server refuses a changed URL with
`error.baseUrlLocked`. To connect to another server, clear the base or create a new source. A
source restored from an archive is frozen permanently, because its URL is part of the archive.

## Progress and stopping

`kb.py --progress` prints `PROGRESS <done>/<total> <space>` on stderr, one line per page; the
Host parses those lines and serves them from `GET /x-knowledge-base/sources/<id>/job` (the legacy `GET …/job` answers for the default source). The page shows pages
done of total, the space being processed, the elapsed time, and a progress bar. "Stop" sends
SIGTERM to the engine process; the run ends in the `cancelled` state rather than being reported
as a failure.

The denominator comes from the `totalSize` of the CQL page search. Confluence Server omits that
field on the plain content listing, so a full import counted through `/rest/api/content` alone
would show pages done and no total; the engine asks the search endpoint first and keeps the plain
listing only as a fallback for installations whose search API is restricted. When no endpoint
reports a count, the page shows pages done without a percentage instead of inventing one.

## Each run becomes an Automation task record

When an import finishes — success, failure, or stopped — the plugin writes the outcome into the
Automation tasks page: source, target, mode, start time, duration, added / changed /
tombstoned / skipped counts, result, and the error when there was one. One record is kept and
updated on later runs; it is created as a one-shot occurrence far in the future and paused
immediately, so it never delivers a message into a conversation. The report itself says it is a
report record rather than a reminder: the import is the plugin's own scheduled work, not a task
waiting to fire.

If the profile has no Automation tasks service, or the service rejects the write, the page says
so and the engine log carries the same statement. Nothing pretends the record exists.

## Several sources, one base each

Every source is one wiki and one knowledge base: its own directory, `kb.sqlite`, manifest,
schedule, import job and Automation task record. An import only ever touches its own base, so a
second wiki can never tombstone the first one's articles.

One source is the **default**: a session with no other binding searches it. A **workspace** may
instead bind an ordered set of sources, and then every tool call from a session in that workspace
reads exactly those, in that order. `kb_status` lists the configured sources, says which one is
the default and which ones the caller reached.

| Tool | With several sources |
|---|---|
| `kb_search` | searches every source of the caller's set and interleaves the per-source rankings; each hit carries `source` and `sourceName` |
| `kb_read` | finds the article in the first source of the set that has it |
| `kb_review` | one queue across the set, each item labelled with its source |
| `kb_status` | one block per source: articles, spaces, statuses, last ingest, index lag |

The `source` parameter of the three read tools restricts a call to one source id.

A tool call's card header — the only part of a call a person reads — is shown in the language
configured for the source the call targets (English or Russian), the same language the settings
page and the import reports use. The result text stays English, like every other tool result: that
is model-facing data, and translating it would change what the model receives.

Migration is silent: an existing single connection (the old `connection.json`) becomes the
default source and keeps its base directory, so articles, manifest and index stay where they are.

## Requirements

- One knowledge base directory per source (`~/.dsh/kb/<id>`; `$KB_HOME` picks the default base
  for the engine), each containing `kb.sqlite` and the article
  files. Create one with `kb.py import --zip …` or `kb.py fetch --url …`; the page can also do it.
- Python on the machine (the DSH bundled runtime is used when present) and the `kb.py` engine
  from this package's repository, or the installed `knowledge-base` skill.
- Node's built-in `node:sqlite` with FTS5, which this DSH build provides.

## Limitations, stated plainly

- Attachment titles are not always valid file names: `image 21:0:24.png` is legal in Confluence and refused by Windows. Every path component is made portable (forbidden characters become `_`, trailing dots go, reserved device names get a prefix) both when an archive is extracted and when an article links to the attachment, so the link and the file on disk keep the same spelling. Two different titles that sanitize to the same name inside one page would collide.
- The plugin needs the host's tool builder (`@deepseek-ai/dsh-tools`). A bundle linked from a checkout loads it from the running application; if neither copy is reachable, the settings page still opens and the `kb_*` tools stay off, with the reason in the Host log.
- Credentials live in the DSH credential store as one record per source, keyed `knowledge-base-tools/<id>`. The store accepts only `<scope>/<id>`; a malformed key makes the application fail to load its credentials file at startup. An earlier version wrote three-segment keys (`confluence-kb/<id>/basic`) and could crash the app; if that happened, remove the `confluence-kb/…` records from `~/.dsh/.credentials.yaml` and save the credentials again. A source id that is not a valid key segment (for example one starting with a digit) gets a stable hash slot `s-<16 hex>`.
- Nothing here reaches Confluence live. A page changed after the last import is invisible until
  the next import, and `kb_status` reports a stale index instead of repairing it.
- Search is lexical (FTS5 prefix matching), not semantic: synonyms need a second query.
- Attachments are files on disk, not indexed text; `kb_read` returns the article body only.
- A cancelled import leaves whatever pages it already wrote; it is not rolled back.
- Stopping is one SIGTERM to the engine; the plugin does not wait to confirm the process died.
- Imports run one at a time per Host; a second request is refused while one is running.
- The space list is a flat, scrollable list: no virtualisation, and the page keeps it in memory.
- A page id lives in one file. An import removes a stale twin carrying the same id (reported as
  `duplicates` in the run summary), and the index keeps one row per id and warns about leftovers
  rather than failing.
- Pages with an empty body are skipped ("no content"): they stay in the wiki, not in the base.
- The run report names the source and its base; the Automation task record is one per source.
- An exported archive is not encrypted: it holds article text and attachments. It carries no
  credentials, but treat the file as the corpus it is.
- The base URL of an imported base is final; moving it to another server means importing the
  archive as a new source, not editing the old one.
