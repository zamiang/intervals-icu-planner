# Contributing

Thanks for your interest in improving intervals-icu-planner!

## Getting started

```sh
npm ci
cp .env.example .env   # fill in your Intervals.icu (and optional Hevy) API keys
npm run check          # smoke-test your credentials
```

Requires Node.js 20+. You'll want your own [Intervals.icu](https://intervals.icu)
account to test against — every write command supports `--dry-run`, so you can
develop without touching your real calendar.

## Development workflow

```sh
npm test              # vitest — the full suite runs offline (API calls are mocked)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format        # prettier --write
```

CI runs `format:check`, `lint`, `typecheck`, and `test` on every PR to `main`,
so run them locally first. An automated Claude review also comments on PRs;
treat its findings as suggestions for the human reviewer, not gospel.

## Pull requests

- Keep PRs focused — one behavior change per PR.
- Add or update tests for any change to scheduling logic (`src/scheduler.ts`),
  API request/response handling (`src/intervals.ts`), or the strength
  importers (`src/strength.ts`). These are the areas where silent regressions
  hurt most.
- Don't hardcode watts, heart rates, or FTP values anywhere — prose uses the
  `{ftp}`/`{lthr}`/`{w:NN}`/`{hr:NN}` placeholders rendered at push time, and
  structured workouts use `% FTP` steps.
- Formatting and style are enforced by Prettier and ESLint; no need to discuss
  them in review.

## Reporting issues

Open a GitHub issue with the command you ran, what you expected, and what
happened. For scheduling bugs, include the `npm run status -- --json` output
(redact anything you consider personal) — the planner's decisions are driven
by that state.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
