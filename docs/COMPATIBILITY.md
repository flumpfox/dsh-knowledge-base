# Compatibility

“Tested” means a real import, search, read, export and update in that environment — not a code
review.

## Confluence

| Confluence | Authentication tested | Status |
|---|---|---|
| Server 8.5.22 — the deployment the plugin was built against | user and password (Basic) | tested: 1734 pages in 24 spaces, full and incremental |
| Server 8.x REST shape — the mock in `engine/tests` | token and user/password, paging, CQL, attachments, 401/403 | tested |
| Server 7.x–9.x | Basic or a token | expected, not verified |
| Data Center with personal access tokens | Bearer | expected; Bearer is covered by the mock, no live Data Center was tried |
| Confluence Cloud | — | not supported: different API and authorization |
| HTML export from Server 8.x | — | tested, including a legacy windows-1251 export |

## Authentication

- Basic (user and password) works on every Server and Data Center installation.
- A token works only where the server accepts `Authorization: Bearer`. A Server without token
  support answers anonymously, and the plugin reports `error.authRejected` instead of an empty
  space list.
- Anonymous access is refused with a clear error before an import starts.

## Agent platform

| Component | Tested | Requirement |
|---|---|---|
| DSH Desktop | 0.2.2-rc.5 (also rc.3 earlier) | `>=0.2.2-rc.1 <0.3.0` |
| Electron | 44.7 | bundled with DSH |
| Node | 24.21.0 | `>=22.5.0` (`node:sqlite`) |
| Python | 3.12.14 (DSH runtime) | 3.12 tested; older versions are checked in CI |
| Operating system | Windows 10/11 x64 | Windows tested; macOS and Linux expected, not verified |

## Reporting a problem

Include the output of `kb_status`, the plugin version, `kb.py --version`, the Confluence version
from the server's About page, the authentication mode, and the steps you took. Do not paste
tokens or passwords; a screenshot of the settings page is enough.
