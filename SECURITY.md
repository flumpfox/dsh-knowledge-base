# Security policy

## Reporting a vulnerability

Do **not** open a public issue for a security problem. Use the repository's private
[GitHub Security Advisories](https://github.com/flumpfox/dsh-knowledge-base/security/advisories) or
write to `flumpfox@gmail.com`.

Please include the version, the platform, the steps and the impact. We aim to acknowledge a report
within a week and to agree on a disclosure date with you.

## What is in scope

- Credential handling: where secrets are stored, whether they can leak into logs, responses, the
  page or an exported archive.
- Archive handling: path traversal, absolute paths, a foreign or malformed archive, a zip bomb.
- The settings HTTP surface: cross-origin writes, the origin fence, unauthorised access to the
  routes.
- Import and export: command injection, file overwrite outside the chosen path, denial of service
  through a crafted archive or a large base.

## What is not in scope

- Vulnerabilities in Confluence itself or in your Confluence configuration.
- The accuracy of the imported content; the base mirrors what the server returned.
- An exported archive is not encrypted: it holds articles and attachments, and anyone with the file
  can read them. It contains no credentials.
- A compromised machine or profile: the DSH credential store and the base directories are outside
  this plugin's control.

## Handling secrets in reports

Never paste a token, a password, a session cookie or an internal host name into an issue, a pull
request or a discussion. Redact them; a screenshot with the values covered is enough.
