# Development

How to work on the repository itself: the environment, the layout, the tests, and the loops for
running it against a live profile.

## Environment

- DSH Desktop `0.2.2-rc.x`; the Host plugin runs inside the app, so the Electron/Node versions come
  from DSH (tested: Electron 44.7, Node 24.21).
- Python 3 for the engine. The plugin prefers the runtime bundled with DSH, then `python3`/`python`.
  `KB_PYTHON` overrides the choice for tests and for the plugin.
- Node 22.5+ is required by the tools (`node:sqlite`); the desktop app provides it.
- Windows, macOS and Linux are supported by the scripts; Windows 10/11 is the tested platform.

## Repository layout

| Path | What it is |
|---|---|
| `engine/kb.py` | the engine: import, fetch, search, audit, export/import of a base |
| `engine/tests/` | fixtures, a Confluence mock, the end-to-end engine cases |
| `plugin/` | the DSH bundle: tools, routes, settings page, locales |
| `skill/` | the skill installed into `~/.dsh/skills/knowledge-base` |
| `tools/` | repository scripts: tests, packaging, the secret check |
| `docs/` | public documentation; `private/` holds maintainer-only documents |
| `dist/` | built packages (ignored) |

## Tests

```powershell
npm test                  # engine cases and the plugin suite
npm run test:engine       # engine only
npm run test:plugin       # plugin only
npm run pack              # build dist/dsh-knowledge-base-<version>.tgz
npm run check-secrets     # scan tracked files and the package
```

The plugin tests spawn the real engine and the mock, so they need Python. They isolate themselves
with `KB_DIR` (a temporary home) and never touch `~/.dsh/kb`; the engine tests use `KB_HOME` or an
explicit `--kb`.

## Running against a live profile

1. In `~/.dsh/profiles/<profile>/package.json`, keep a link dependency to `plugin/` and add the
   package name to `dsh.profile.bundles`; run `pnpm install` in the profile.
2. Toggle the bundle with `set_bundle` after Host changes; a linked module reloads without a
   restart. Client changes need a page refresh (the packaged app has no refresh shortcut; restart
   or use DevTools).
3. Renaming the package or changing its row id needs an app restart, because the loader reads the
   profile at startup.

Data lives outside the repository: `KB_DIR` (default `~/.dsh/kb`) holds `knowledge-sources.json`,
one directory per source and `exports/`.

## Debugging

- The Host log gets plugin warnings, including the `dsh-tools` fallback and route-registration
  failures.
- `GET /x-knowledge-base/sources` and `/sources/<id>/state` describe the registry and the source;
  `lastRejectedWrite` explains a refused cross-origin write.
- An import's `job` carries the last 40 engine lines; `kb.py --version` identifies the engine, and
  `kb.py inspect --zip` validates an export without touching a base.
- A source's base directory can be checked directly: `kb.py --kb <dir> stats` and
  `kb.py --kb <dir> search "term"`.

## Release loop

1. Bump the version in `plugin/package.json`, update both changelogs.
2. `npm test` and `npm run check-secrets` must be green.
3. Tag `vX.Y.Z` in the private repository; the release workflow builds the `.tgz`, `skill.zip`
   and `SHA256SUMS` and attaches them to the GitHub Release.
4. Install the release on a clean profile before announcing it.

## Restoring on a new machine

Install DSH, clone the repository, put `skill/` into `~/.dsh/skills/knowledge-base`, install the
bundle, then create the source and enter the credentials. Details and the pre-1.0 migration:
[docs/UPGRADING.md](UPGRADING.md).
