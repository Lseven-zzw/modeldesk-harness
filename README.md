# ModelDesk Harness

English | [中文](README.zh.md)

ModelDesk Harness is a self-hosted agent workbench built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It includes a desktop client and a management console for employee access, model channels, usage, and shared skills, documents, and MCP services.

<a id="run"></a>
## Run the server and management console

1. Copy `server/.env.example` to `server/.env`. Set the MySQL passwords, database URL, application keys, and administrator seed password. See the [server guide](server/README.md) for the required formats.
2. From `server/`, start the stack with `docker compose up -d --build --wait`.
3. Run `docker compose exec server python -m app.seed` once, then sign in at `http://127.0.0.1:8080/admin/login`.
4. Add an upstream model and grant access in the management console before connecting a client.

This release uses a new database and desktop application identity. Use fresh storage for the first deployment.

<a id="run-from-source"></a>
## Develop the desktop client

Use Node.js 24.9 or newer and the pnpm version pinned in [package.json](package.json). Run `pnpm install --frozen-lockfile` and `pnpm run dev:desktop` from the repository root. Configure the ModelDesk server address in the desktop account settings. See [desktop packaging](apps/desktop/packaging/README.md) for platform requirements.

## License

The source is distributed under the [MIT License](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for separately licensed dependencies.
