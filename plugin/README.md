# dsh-knowledge-base plugin

Russian translation: [README.ru.md](README.ru.md).

DSH bundle that builds local knowledge bases for the agent: four tools over the corpus produced by
`kb.py`, plus a Settings → Knowledge base section that configures the source, imports spaces, shows
live progress, exports and imports bases, and records each run in the Automation tasks page.
Confluence Server / Data Center is supported now (REST API or an HTML export); Jira, Obsidian and
other sources are planned.

| Half | File | Responsibility |
|---|---|---|
| Host | `index.js` | registers the tools and the settings routes |
| Host | `server.js` | `/x-knowledge-base/*`: source registry, per-source state, test, spaces, import, job, cancel, credentials, clear, export, import-base, pick-folder, locale |
| Host | `lib/registry.js` | pure registry model: sources, default, workspace sets, result merge |
| Host | `lib/core.js` | pure progress / summary / URL / schedule / path helpers (no I/O) |
| Client | `client.js` | the settings section: source list, creation form, editor, workspace sets |
| Copy | `locale/{en,ru}.json` | every user-facing string, including the Automation task report |

## Routes

All routes live under `/x-knowledge-base` and answer JSON.

| Route | Purpose |
|---|---|
| `GET/POST /sources` | list the registry; create a source with a name and an id |
| `POST /default`, `POST /workspaces` | choose the default source; bind a workspace set |
| `GET/POST /sources/<id>` | read the state; save the source settings |
| `POST /sources/<id>/{delete,clear}` | delete the source; delete its base files only |
| `POST /sources/<id>/{test,spaces}` | check the connection; list spaces |
| `POST /sources/<id>/{import,cancel}` | start an import; stop it |
| `GET /sources/<id>/{job,export}`, `GET /sources/<id>/export/job` | import progress; export plan and progress |
| `POST /sources/<id>/export`, `POST …/export/{cancel,reveal}` | start packing, cancel it, reveal the archive |
| `POST /sources/<id>/{token,basic}` | save or delete credentials |
| `POST /import-base`, `POST /pick-folder` | restore a portable base; open the system folder chooser |
| `GET /locale/<lang>.json` | dictionaries used by the page |

## Install

Install `dsh-knowledge-base-<version>.tgz` from the GitHub Releases page (DSH → Plugins → Add
plugin, or `plugin_manager install_bundle <path>`), put `skill.zip` into
`%USERPROFILE%\.dsh\skills\knowledge-base\`, then restart the app.

For development, link `plugin/` into a profile (`link:` dependency plus the bundle entry) and
toggle the bundle with `set_bundle`; a linked Host module reloads without a restart, client changes
need a page refresh. `npm test` runs the plugin suite (51 cases) through the repository tooling,
which also finds Python for the integration tests.

A linked bundle resolves imports from the checkout, not from the profile, so
`@deepseek-ai/dsh-tools` is loaded lazily: first as a normal import, then from the running
application's own copy inside `app.asar`. Without that fallback the bundle failed to start with
`ERR_MODULE_NOT_FOUND` and the settings page stayed dark. `tests/boot.test.js` pins the degraded
behaviour: no tool builder means no `kb_*` tools and a logged warning, never a dead plugin.

See [docs/DETAIL.md](docs/DETAIL.md) (Russian: [DETAIL.ru.md](docs/DETAIL.ru.md)) for behaviour,
requirements and limitations.
