# Upgrading

## From a pre-public 2.x build to 1.0.0

The package name, route prefix, credential scope, registry file and base layout all changed, so
there is **no automatic migration**. The base itself is not rewritten: renaming its directory keeps
every article.

1. Stop the app and back up `%USERPROFILE%\.dsh\kb` and `%USERPROFILE%\.dsh\.credentials.yaml`.
2. Rename the base directory, for example `~/.dsh/kb/confluence` → `~/.dsh/kb/<id>` (the id you will
   use, e.g. `confluence-fuzzy`). A rename on the same volume, not a copy.
3. Install the skill: copy `skill/` into `%USERPROFILE%\.dsh\skills\knowledge-base\`.
4. Install the bundle `dsh-knowledge-base-1.0.0.tgz` (or link `plugin/` for development) and make
   sure the profile's dependency and `dsh.profile.bundles` name `@flumpfox/dsh-knowledge-base`.
5. Start the app, open Settings → Knowledge base and create a source with the id you chose, the same
   base URL as before, and its spaces. The page will use `~/.dsh/kb/<id>`, which now holds the old
   articles; the article count should match the old one.
6. Enter the credentials again: 1.0.0 reads `knowledge-base-tools/<id>` and does not look at the
   old `confluence-kb-tools/...` record. Saving does not need a reachable server.
7. Do not start an import if the server is unavailable; verify the local base instead:
   `kb.py --kb ~/.dsh/kb/<id> stats` and `kb.py --kb ~/.dsh/kb/<id> search "term"`.
8. Remove the old skill directory and the old registry file once the new source works.

If you kept an exported base archive from before 1.0.0, it still opens: the old
`confluence-kb.json` / `dsh-confluence-kb-base` marker is accepted by `unpack`.

## From an earlier 1.x release

Pull the repository, run `npm test` and `npm run pack`, install the new bundle and restart the app
when the package name or the bundle row changed. Bases and sources stay where they are.

## Rolling back

Before upgrading, keep the previous `.tgz` and a bundle snapshot of the repository: the project's
private history uses tags for exactly this. A rollback reinstalls the previous bundle; the data
directory is untouched unless the format changed (it did once, at 1.0.0 — see above).
