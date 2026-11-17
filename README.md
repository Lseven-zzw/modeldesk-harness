# ModelDesk Harness

English | [中文](README.zh.md)

ModelDesk Harness is a self-hosted agent workbench based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Employees use the desktop client to call approved models and access shared skills, documents, and MCP services. Administrators configure model access, quotas, and usage in the web console.

**Project status** · Source preview. GitHub CI exercises the server, fresh MySQL 5.7 migrations, and the management console. Build the desktop client from source. Published, signed installers and migrations from older deployments are outside the current preview scope.

<a id="run"></a>
## Run the server and management console

1. Install Docker with the Compose plugin. Clone the repository and copy `server/.env.example` to `server/.env`.

   ```sh
   git clone https://github.com/Lseven-zzw/modeldesk-harness.git
   cd modeldesk-harness/server
   cp .env.example .env
   ```

2. In `server/.env`, set these values before starting the stack.

   | Setting | Value |
   | --- | --- |
   | `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` | Two distinct database passwords |
   | `MODELDESK_COMPOSE_DATABASE_URL` | `mysql+pymysql://modeldesk:<URL-encoded MYSQL_PASSWORD>@mysql:3306/modeldesk?charset=utf8mb4` |
   | `MODELDESK_SECRET_KEY`, `MODELDESK_MASTER_KEY` | A random session signing secret and a separate URL-safe Base64 encoding of 32 random bytes |
   | `MODELDESK_SEED_ADMIN_PASSWORD`, `MODELDESK_SEED_EMPLOYEE_PASSWORD` | Two distinct passwords of 12–128 characters. The employee password initializes both demo accounts. |
   | `MODELDESK_BASE_URL` | Keep `http://127.0.0.1:8080` for local testing. Use an HTTPS origin reachable by desktop clients for remote access. |

3. Start the stack on a fresh database, initialize the accounts, and check the server.

   ```sh
   docker compose up -d --build --wait
   docker compose exec server python -m app.seed
   curl -fsS http://127.0.0.1:8080/healthz
   ```

4. Open `http://127.0.0.1:8080/admin/login` and sign in as `admin`. Configure an OpenAI-compatible upstream model channel, enable a model, and grant access to an employee. Test desktop sign-in with `zhang.san` or `li.si` using the seed employee password. For deployments with real users, disable the demo accounts.

See the [server guide](server/README.md) for database, roles, storage, and parser configuration.

<a id="run-from-source"></a>
## Run the desktop client from source

Use Node.js 24.9 or newer and the pnpm version pinned in [package.json](package.json). From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm run dev:desktop
```

In the desktop account settings, enter the server origin from `MODELDESK_BASE_URL` and sign in through your browser. Confirm that the granted model appears in the selector and completes a test conversation. See [desktop packaging](apps/desktop/packaging/README.md) for platform prerequisites.

## Contributing and support

Report bugs or propose changes through [GitHub Issues](https://github.com/Lseven-zzw/modeldesk-harness/issues). See the [contribution guide](CONTRIBUTING.md) for pull requests and [the security policy](SECURITY.md) for private vulnerability reporting.

## License

The source is distributed under the [MIT License](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for separately licensed dependencies.
