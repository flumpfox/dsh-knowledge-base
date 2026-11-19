# Contributing

Thanks for taking the time. This is a small project with a few rules that keep it predictable.

## Before you start

- Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the environment, the layout and the test
  commands.
- For a bug, open an issue with the bug template. Include the DSH version, the Confluence version,
  the authentication mode, `kb_status` output and the steps. Never paste tokens or passwords.
- For a larger change, open an issue first so the direction is agreed before the code.

## Pull requests

- Keep a pull request focused: one problem, one change, with a short description of why.
- Run `npm test` and `npm run check-secrets` before pushing; both must be green.
- User-visible strings belong in `plugin/locale/{en,ru}.json`, never inline in the code.
- Documentation is bilingual: change `X.md` and `X.ru.md` together.
- A behaviour change needs a test; a CLI change needs the engine tests updated.
- No secrets, internal host names or personal paths in code, tests, docs or fixtures.

## Style

- JavaScript is plain ESM with no runtime dependencies; Python is stdlib only.
- Comments explain *why* something is done, not what the next line does.
- Commit messages state the problem and the decision, not only the files touched.

## Conduct

Be civil and assume good faith. Harassment, personal attacks and discriminatory language are not
welcome and will be removed; maintainers may block accounts that persist.

## License

By submitting a contribution you agree it is licensed under the MIT license of this repository.
