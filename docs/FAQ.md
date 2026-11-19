# FAQ

## An article link opened “file not found”

The link was relative (`projects/a.md`). The app resolves a relative link against the session
workspace, and the knowledge base lives under `~/.dsh/kb`, outside it. Tool results now print an
absolute `file=` path; cite that one. An answer written before the fix keeps its broken link — ask
again to get a working one.

## The app failed to start after I saved a login

The credential store accepts exactly `<scope>/<id>`. An earlier version wrote three-segment keys
(`confluence-kb/<source>/basic`), which made the provider fail to load its file and stopped the whole
application at startup. 1.0.0 keeps one record per source under `knowledge-base-tools/<id>`. If an
old key is still in `~/.dsh/.credentials.yaml`, remove the `confluence-kb/…` records and save the
credentials again.

## Why can't I change the base URL?

The source has already imported from it, and the articles carry that URL. Editing it would make the
local base claim a server that never hosted the content. Delete the base files to unlock the field,
or create a new source for another server. A source restored from an archive stays frozen.

## Where is my knowledge base?

`%USERPROFILE%\.dsh\kb\<id>\`, where `<id>` is the source id; the registry is
`%USERPROFILE%\.dsh\kb\knowledge-sources.json`. The default source's directory also answers to
`KB_HOME` if you set it for the engine.

## Why is the exported archive so large?

It carries the articles, the index and every attachment. The extracted export used as import input
(`raw/`) is left out. A real base of 1734 pages was about 1 GB with attachments.

## Why does the export count differ from the settings page?

Attachments may include markdown files; they travel in the archive but are not articles. The count
now excludes them, so both numbers agree.

## Can I restore a base exported before 1.0.0?

Yes. Archives with the earlier `confluence-kb.json` / `dsh-confluence-kb-base` marker are still
accepted by `unpack`; an archive written by 1.0.0 uses `knowledge-base.json`.

## Why doesn't the in-app browser log in with the plugin's credentials?

The browser tab is an isolated Chromium session with its own cookies, and it rejects URLs that
contain a login and password; the Host cannot inject headers into it. Use the default browser for
the original page (Settings → General → “Open chat links in”), where your session already exists.

## Why is Confluence Cloud not supported?

Cloud uses a different authorization flow and a different REST surface. The plugin targets Server
and Data Center; Cloud would be a separate adapter.

## Why was a second import refused?

Imports run one at a time per source. Wait for the running job or stop it; another source can import
in parallel.

## Where are the credentials stored?

In the DSH credential store (`%USERPROFILE%\.dsh\.credentials.yaml`), one record per source, never
in the base, never in an exported archive, never in git. The run passes them to the engine through
the environment.
