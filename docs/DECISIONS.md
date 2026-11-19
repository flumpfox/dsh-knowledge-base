# Decisions

Short records of choices that are easy to undo by accident. Each one says what was decided, why,
and what it costs to change.

### Credential keys are exactly `<scope>/<id>`

The DSH credential store accepts only two segments and fails to load its file when one is malformed.
The plugin keeps **one record per source**, key `knowledge-base-tools/<id>`, with the auth kind in
the payload. Three-segment keys once crashed the application at startup; changing this shape means
migrating every stored record.

### The tool builder is loaded lazily

A linked bundle resolves imports from the checkout, not from the profile, so
`@deepseek-ai/dsh-tools` is not on its module path. It is imported first as a normal package, then
from the running application's `app.asar`. Without the fallback the plugin failed to start with
`ERR_MODULE_NOT_FOUND`.

### The Host injects `webServer`

Routes are registered in `apply`, and at startup the HTTP carrier may not be ready when the row
activates. Declaring `inject: ['tools', 'webServer']` makes activation wait for it; before that the
routes silently did not exist.

### Cross-origin writes follow DSH's rule

A write with no browser markers (`Origin`/`Referer`) is allowed — the desktop shell and local tools
send none. A browser page always sends its own origin, so a foreign origin and `Origin: null` are
refused with `error.crossOrigin`. A stricter rule broke every write from the app itself.

### Progress has a documented contract

The engine prints `PROGRESS <done>/<total> <space>` on stderr for imports and `PACK <done>/<total>`
in bytes for packing; the Host parses exactly these lines. Changing the format breaks the page and
the tests together.

### A base URL freezes after import

Articles carry the URL they came from, so editing the URL after content exists would make the base
lie about its origin. The field becomes read-only, the Host refuses a change with
`error.baseUrlLocked`, and clearing the base of an ordinary source lifts the freeze.

### Deleting the last source is allowed

An empty registry is a real state, not a corrupt one: the page shows an empty state and the first
source is created explicitly. The engine and the tools handle "no sources" without falling back to
a guessed default.

### Export writes a temporary file and renames it

A failed or cancelled pack must never destroy the previous archive. The engine writes `<name>.tmp`
and replaces the target on success; cancel removes the temporary file.

### Article count excludes attachment `.md`

A page may attach a markdown file; it travels in the archive but is not an article. Counting every
`.md` made the export report 1742 instead of 1734.

### Tool results cite absolute file paths

The app resolves a relative link against the session workspace, and the base lives elsewhere, so a
relative path opens nothing. Tools print absolute forward-slash paths, and the descriptions and the
skill require citing them verbatim.

### The in-app browser gets no plugin credentials

The browser tab is an isolated Chromium session with its own partition, and it rejects URLs that
carry credentials; the Host cannot inject headers into it. Opening the original page in the default
browser is the supported route.

### The engine resolves the default base from the registry

`--kb` wins; with none, the engine reads `$KB_DIR` (or `~/.dsh/kb`) `knowledge-sources.json` and
uses the default source; with neither it explains that no base is configured instead of guessing a
path.

### The archive format keeps the old marker readable

Archives are written as `knowledge-base.json` / `dsh-knowledge-base-base`, but
`confluence-kb.json` / `dsh-confluence-kb-base` still opens, so a base exported before the rename
can be restored. Dropping the old marker later is a deliberate breaking change.
