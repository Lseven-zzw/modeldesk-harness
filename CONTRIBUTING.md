# Contributing to ModelDesk Harness

English | [中文](CONTRIBUTING.zh.md)

Use [GitHub Issues](https://github.com/Lseven-zzw/modeldesk-harness/issues) for bugs and proposals. Include the affected commit or version, operating system, reproduction steps, and expected result. Remove credentials and private data from logs or examples. Report vulnerabilities through the [security policy](SECURITY.md).

## Open a pull request

1. Create a branch from `main`. Fork the repository first if you lack write access.
2. Keep the change focused. Update both README languages when setup or usage changes.
3. Run checks that cover the affected code. Open a PR into `main` and describe the change and the checks you ran.
4. Wait for the `server` and `admin` checks to pass. Resolve review conversations and update your branch if `main` advances.

## Local checks

```sh
cd server
uv sync --locked
uv run --locked pytest -q
cd admin
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

For desktop or shared TypeScript changes, run `pnpm install --frozen-lockfile` and `pnpm run build` from the root.
