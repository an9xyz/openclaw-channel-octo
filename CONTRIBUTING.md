# Contributing to openclaw-channel-octo

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/Mininglamp-OSS/openclaw-channel-octo.git
cd openclaw-channel-octo
npm install
npm run type-check
npm test
```

## Development workflow

1. Create a feature branch from `main`.
2. Make your changes — keep commits focused and atomic.
3. Run `npm run type-check && npm test` before pushing.
4. Open a pull request against `main`.

## Code style

- TypeScript strict mode is enabled.
- No external linter/formatter is configured yet — match the existing style.
- Prefer explicit types over `any` where feasible.

## Reporting issues

Open an issue at https://github.com/Mininglamp-OSS/openclaw-channel-octo/issues.
