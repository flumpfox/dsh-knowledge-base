---
name: knowledge-base
description: "Search and cite the knowledge bases (markdown corpora under ~/.dsh/kb/<id>) before answering questions about internal infrastructure, PostgreSQL/Patroni, networking, hosts, or runbooks. Confluence is the current source — HTML exports or the REST API; Jira, Obsidian and others are planned. Also covers importing, exporting and auditing the bases."
whenToUse: "The question may be answered by an internal wiki article (infrastructure, databases, deployment procedures, hostnames, ports, limits, runbooks), or the user asks to import, refresh, or review the knowledge base."
---

# Knowledge base

Russian translation of this document: [SKILL.ru.md](SKILL.ru.md).

A local markdown corpus built from external sources — Confluence HTML exports or its REST API today. One article per page,
with provenance and freshness metadata in the frontmatter.

- Root: one directory per source, `~/.dsh/kb/<id>` (Windows: `C:\Users\<user>\.dsh\kb\<id>`). `--kb` picks one; without it the engine uses `KB_HOME`, else the registry default, else explains that no base is configured.
- `INDEX.md` — generated table of contents by space.
- `scripts/kb.py` — `import`, `inspect`, `fetch`, `search`, `get`, `audit`, `stats`, `index`, `pack`, `unpack`; `--version` prints the engine version. Run it through `scripts/kb.ps1` on Windows or `scripts/kb` elsewhere; both find a working Python.
- `MANIFEST.jsonl` — one row per page: hash, dates, signals. Diffing lives here, not in the article.

Resolve `scripts/…` against this skill's base directory.

## Which base an answer comes from

Several sources may be configured, each its own base (`~/.dsh/kb/<id>`). The tools resolve the caller's workspace: a workspace with a bound
set searches exactly those sources, otherwise the default one. Every hit says which source it came
from; `kb_status` lists the sources, the default and what the caller reached. The CLI below takes
one base at a time through `--kb`, so point it at the directory of the source you mean.

## Answering from the base

When the `dsh-knowledge-base` plugin is installed, its tools are the primary path: `kb_search`,
`kb_read`, `kb_review`, `kb_status`. They return provenance with every hit, so no extra rule is
needed to see staleness. Use the CLI below when the plugin is absent, or for maintenance.

1. **Search before answering**; never recall an internal fact from memory when the base can
   hold it: `pwsh -File <skill>/scripts/kb.ps1 search "patroni etcd"`.
   FTS5 with prefix matching: 2–4 distinctive terms, Russian or English, no quotes needed.
2. **Read the frontmatter of every hit** before trusting the body. Four fields decide:
   - `status` — `current` is usable; `legacy`/`deprecated` is history, say so explicitly.
   - `source_updated` — when the page itself last changed (`unknown` means nobody knows).
   - `ingested` — when this export was taken.
   - `review_after` — the date after which the article is due for re-verification.
3. **Read 1–3 whole articles**, not snippets, when the answer is procedural. Use `get <id>`.
4. **Cite what you used** in the answer: article title or `id` + `source_updated`. Link the article
   with the **absolute** `file=` path the tool prints (e.g. `[07. Статистика](C:/Users/me/.dsh/kb/confluence-fuzzy/projects/07-...md)`).
   A relative path is resolved against the session workspace, and the base lives outside it, so the
   app would answer "file not found"; the absolute path opens the article in the side panel.
   The tool also prints `source=` — the original Confluence page. Include that link too, so the
   reader can open the wiki page in a browser (DSH opens chat links where Settings → General →
   "Open chat links in" says: the in-app sidebar or the default browser).

## Freshness rules (non-negotiable)

Split what you are about to say into durable and volatile:

- **Durable**: why a decision was made, architecture rationale, trade-offs, failure modes,
  conceptual explanations. Age matters little; an old rationale is still valid reasoning.
- **Volatile**: exact versions, IP addresses, hostnames, ports, paths, credentials, quotas,
  limits, UI steps, command flags. These rot silently and look authoritative while wrong.

Rules:

- A volatile fact from an article whose `source_updated` is older than ~6 months, or `unknown`,
  or whose `status` is not `current` — do **not** state as present tense. Either verify it live
  (a command, a config file, `--version`) or phrase it as "по состоянию на <date>, в статье
  <id> указано …" and flag it as possibly outdated.
- Prefer a live check over the wiki whenever the check is cheap. The wiki records intent at a
  point in time; the machine records the present.
- If two articles disagree, prefer the newer `source_updated` and mention the conflict instead
  of silently choosing.
- Deprecated articles stay in the base on purpose (tombstones). Use them to explain history and
  to warn about removed things, never as the current procedure.

## Project overrides

Before answering in a project, check for `<project>/.dsh/kb-overlay.md`. It pins
project-specific facts ("here PostgreSQL 18, not 16", "different addresses") and **wins over
the base**. When an overlay contradicts an article, say which one you followed.

## Maintaining the base

Import a new export (idempotent, safe to run repeatedly):

```
pwsh -File <skill>/scripts/kb.ps1 import --zip <path> --base-url https://confluence.example
```

Or pull straight from the Confluence REST API (Server/Data Center), all visible spaces:

```
pwsh -File <skill>/scripts/kb.ps1 fetch --url https://confluence.example \
    --token $env:CONFLUENCE_TOKEN --space-type all
```

A Confluence **Server** that does not support personal access tokens ignores
`Authorization: Bearer` and answers as an anonymous user with an empty space list. Use Basic
auth there instead — the user name is a flag, the password comes from the environment:

```
$env:CONFLUENCE_PASSWORD = '...'
pwsh -File <skill>/scripts/kb.ps1 fetch --url http://confluence.example:8090 \
    --user your.name --space-type all
```

`fetch` writes an export-shaped archive from the API and runs the same importer, so within one
base an API pull and a file import diff against each other. Different *sources* keep different
bases (see "Which base an answer comes from"), so they never diff against one another. Useful flags: `--spaces KEY1,KEY2`,
`--since 2026-11-01` (only pages changed after a date), `--list-spaces`, `--no-attachments`,
`--save-zip <file>` to keep what was pulled.

Before importing, an archive can be checked without touching the base:

```
pwsh -File <skill>/scripts/kb.ps1 inspect --zip <path> [--json]
```

It reports the size, the number of page HTML files, and the spaces found in each
`index.html`, with stable error codes (`file-missing`, `file-empty`, `file-not-zip`,
`file-no-pages`). `import --spaces KEY` narrows a multi-space archive; pages of the other
spaces are still counted as present, so narrowing never tombstones them.

Both `import` and `fetch` accept `--progress`, which prints
`PROGRESS <done>/<total> <space>` lines on stderr, one per page (the space may be absent
while it is still unknown). The DSH settings page parses exactly that format; keep it stable.

- Unchanged pages are left byte-identical, so hand-added notes survive.
- Changed pages are regenerated from the export; frontmatter fields `status`, `tags`, `notes`,
  `owner`, `review_after`, `pin` are preserved.
- Pages missing from the new export are tombstoned (`status: deprecated`, `deprecated_on`), never deleted.
- Afterwards run `audit` to see the review queue, and `stats` for counts.

With the plugin installed, Settings → Knowledge base drives the same engine: it stores the
source (server URL + token, or an export path), the selected spaces, and the schedule, shows
live progress with a Stop button, and records each run in the Automation tasks page.

### Moving a base to another machine

```pwsh
pwsh -File <skill>/scripts/kb.ps1 pack --out base.zip --meta meta.json
pwsh -File <skill>/scripts/kb.ps1 unpack --archive base.zip --check --json
pwsh -File <skill>/scripts/kb.ps1 --kb <dest> unpack --archive base.zip --json
```

The archive holds the articles, `MANIFEST.jsonl`, `kb.sqlite`, attachments and a
`knowledge-base.json` with the source name, kind, base URL, spaces and schedule. It never holds
credentials. Archives with the earlier `confluence-kb.json` / `dsh-confluence-kb-base` marker still open. `pack --progress` prints `PACK <done>/<total>`. `unpack --check` validates without writing; a restored base keeps updating from the
same server with whatever credentials the new machine stores. The settings page does both
(Export base / Import base) and freezes the URL of an imported base — another server is a new
source, not an edit.

Reviewing an article after a check:

- Body edits are lost on the next reimport — record conclusions in frontmatter instead:
  `review_after: 2027-01-01`, `notes: "проверено на pg01 2026-11-20, версия 17.2"`.
- Mark superseded content `status: legacy` and point `superseded_by: <id>` rather than deleting it.

## Limits

- Attachments (diagrams, PDFs, ini files) live in `attachments/<pageId>/` as files, not as indexed
  text; open them by path when an article references them.
- Macros with no exported preview (Jira, drawio source, include) appear as placeholders such as
  `*[Jira macro not exported]*`. Say the data is absent rather than inventing it.
- The search index is derived; `kb.py index` rebuilds it if `kb.sqlite` is missing or stale.
- One `id` is one file. An import deletes a stale twin carrying the same id (the summary counts it
  as `duplicates`) and the index keeps one row per id, warning about leftovers instead of failing.
- Attachment titles are made portable: `image 21:0:24.png` becomes `image 21_0_24.png` both on
  disk and in the link an article carries.
- Pages with an empty body are skipped ("no content") and stay out of the base.
