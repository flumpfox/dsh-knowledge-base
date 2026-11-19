# Changelog

Public releases start here. Earlier 2.x iterations were private pre-public builds and are not part
of this history (their notes live in the private repository).

## 1.0.0 — 2026-11-19

First public release: the plugin is now **dsh-knowledge-base**.

### Added

- Local knowledge bases for the agent built from external sources. Confluence Server / Data
  Center is supported now — over its REST API (a personal access token or user and password) or
  from an HTML export zip; Jira, Obsidian and other sources are planned.
- Several sources, each with its own base, its own schedule and its own import job. One source is
  the default; a workspace may bind an ordered set of sources instead.
- Four tools — `kb_search`, `kb_read`, `kb_review`, `kb_status` — with provenance on every
  result: the article's last-modified date, status and review flags travel with the fact.
- Settings → Knowledge base: a source list where the first source is created with a name and an
  id of your choice, a connection test, a space picker, the schedule, live progress with Stop,
  the last run, and workspace sets.
- Portable base archives: export asks for a folder and a file name, shows byte progress, can be
  cancelled, offers “Open folder”, and asks before replacing an existing file. The archive
  carries the base URL but never credentials; import it on another machine and keep updating it
  from the same server with new credentials.
- A source's base URL becomes read-only once it has imported from it; deleting the base files
  unlocks it, deleting a source removes its files too.
- An honest record per run in the Automation tasks page: a report, not a reminder.
- Bilingual UI (ru/en); tool card titles follow the language of the source they target.
- Cross-platform tooling: `npm test`, `npm run pack`, `tools/check-secrets.mjs`, and a Python
  launcher for the skill that works on Windows, macOS and Linux.

### Changed

- The package is `@flumpfox/dsh-knowledge-base` (previously a local-only name); routes moved to
  `/x-knowledge-base`, the credential scope to `knowledge-base-tools`, the registry to
  `knowledge-sources.json`, sources to `~/.dsh/kb/<id>`, and the skill to `knowledge-base`.
- The engine resolves the default base from the registry when `--kb` is omitted, and
  `kb.py --version` reports its version.
- Portable archives are written as `knowledge-base.json` with `"format": "dsh-knowledge-base-base"`;
  archives with the earlier `confluence-kb.json` / `dsh-confluence-kb-base` marker still open.

### Upgrade

- From a pre-public 2.x build: no automatic migration. See `docs/UPGRADING.md` — rename the base
  directory, recreate the source, re-enter the credentials.
