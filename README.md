# Savia Studio

[![Coverage](https://github.com/hefesoftsas/savia-studio/actions/workflows/coverage.yml/badge.svg?branch=main&event=push)](https://github.com/hefesoftsas/savia-studio/actions/workflows/coverage.yml?query=branch%3Amain+event%3Apush)

Savia Studio is an industry-agnostic low-code platform. Build collections,
relationships, forms, and screens for each organization, with API access,
permissions, and persistence on Cloudflare Workers, D1, and R2.

New developers can start with the [documentation and onboarding guide](docs/).
The public repository includes the plugin SDK, example plugins, and the generic
quote engine. Optional business solutions are available as configuration
packages. Open **Manage pages → Solution packages**, select a workspace, and
review a package before installing it. Disabling a package preserves its records.
See the [solution package guide](docs/solution-packages.md).

## Components

- `apps/admin` contains the React frontend and low-code designer, built with
  React Admin and shadcn. Open Studio at `#/studio?domain=platform&view=admin`.
  `#/crm` is a legacy alias.
- `apps/api` serves the public API, its OpenAPI contract, and domain operations.
- `apps/auth` provides Better Auth sign-in, TOTP MFA, and OAuth/OIDC.
- `apps/mcp` provides MCP access to API operations.
- `apps/connector-gateway` is a private Worker that executes
  extension-declared adapters with encrypted tenant connections.

## Container development

Start the stack from the repository root with Docker Desktop or Docker Engine
with Compose.

```sh
docker compose up --build --wait --wait-timeout 600
```

Open [Admin](http://127.0.0.1:5173/) or the
[API reference](http://127.0.0.1:8787/docs). The container installs the pinned
pnpm dependencies, applies local migrations, and starts the development stack
with live reload. [Mailpit](http://127.0.0.1:8025/) captures development email.
The container supplies Node and pnpm.

In VS Code, **Dev Containers: Reopen in Container** opens the same Compose
service, forwards the application ports, and verifies readiness. See the
[local setup guide](docs/onboarding/03-local-setup.md) for sign-in, persistent
data, optional secrets, and troubleshooting.

## Local development

Use `pnpm dev` to start the stack with live reload.

```sh
pnpm dev
```

The command starts Admin, API, Auth, and the private connector gateway. MCP
starts when `SAVIA_MCP_SHARED_SECRET` is set. The assistant requires MCP.

Admin opens at `http://127.0.0.1:5173/` by default. The launcher selects another
port if needed and prints the URL. Set `SAVIA_ADMIN_PORT` to choose a port.
The API and authentication pages use `http://127.0.0.1:8787`.

A single local Wrangler runtime runs the API and connector gateway as separate
Workers. It owns `apps/api/.wrangler/state` to avoid SQLite locks during reload.
Keep that state directory dedicated to this runtime. The launcher generates
Worker configurations and private `.dev.vars` under
`apps/api/.wrangler/local-runtime` from local files and `infra/secrets/`.
It preserves the originals and conceals their values. Admin calls the API
through the Vite origin during development.

Run the reset script without arguments to preview changes to generated
Miniflare data.

```sh
node scripts/reset-savia-local-state.mjs
```

After reviewing the plan, confirm the reset explicitly. This command targets
the local state for API, Auth, and Savia Request.

```sh
node scripts/reset-savia-local-state.mjs --confirm-local-reset
```

PostgreSQL serves as a source for legacy imports. Start it when needed with
`pnpm legacy:postgres`. Before importing, validate it with
`POSTGRES_URL=... sh scripts/verify-postgres-source.sh`.

### Extension connections

Extensions can declare connectors and actions. Administrators configure their
connections from the extension screen. Saved credentials stay on the server.
The private connector Worker runs the adapters.

For local testing, create the Git-ignored
`infra/secrets/connector-gateway.dev.env` with
`EXTENSION_CONNECTIONS_ENCRYPTION_KEY`, a base64-encoded 32-byte key.
`pnpm dev` passes it to the API and connector gateway, applies migrations,
and configures their service bindings.

## Admin authentication

### Local test accounts

Use these accounts only in local Miniflare development.

| Account                   | Email                                    | Access                        |
| ------------------------- | ---------------------------------------- | ----------------------------- |
| Savia Local Administrator | `savia.admin@example.test`               | Platform administrator        |
| Agency Viewer             | `agency-viewer-flow-20260902@savia.test` | Read-only access to agency 12 |

Both accounts use the temporary password `TestUser321!`. The platform
administrator also needs the enrolled MFA code. Reprovision these accounts if
you reset the Git-ignored Miniflare state.

Admin authenticates with Better Auth using Authorization Code with PKCE.
The session starts after sign-in and any required MFA.

1. Better Auth issues a five-minute access token.
2. The API stores the refresh token in an `HttpOnly` cookie scoped to Admin's
   authentication routes.
3. Admin restores the session after a reload and refreshes the access token
   before it expires.
4. API calls include `Authorization: Bearer <access token>`.
5. Signing out clears the refresh cookie and the Better Auth session.

The Admin OAuth client requests `offline_access` for session renewal. The
`savia.api.read` and `savia.api.write` scopes determine permissions.

## Verification

```sh
pnpm typecheck
pnpm test
sh scripts/verify-local-stack.sh
```

Use `pnpm test:coverage` to run JavaScript and TypeScript coverage and build the
merged report. See the [coverage guide](docs/guides/test-coverage.md) for test
groups, CI reports, and coverage scope.

The API contract is available at `/openapi.json` and the Scalar reference at
`/docs`.

## External CRM (HubSpot)

Agency administrators manage their CRM connection at `#/crm-connections`.
HubSpot is the first supported external CRM. The API exposes normalized
contact, company, and deal operations under `/v1/crm/*`, scoped to the agency
and the user's active membership. Nango manages consent and OAuth tokens.
See the [Nango and HubSpot runbook](docs/runbooks/nango-hubspot.md) for
production configuration and connection checks.

## Assistant

The admin panel connects its assistant to the domain API through FastMCP.
Read operations run immediately. Changes are proposed for five minutes and
require explicit confirmation from the same user.

The local assistant reads its configuration from these Git-ignored files.

```dotenv
# infra/secrets/assistant-api.dev.env
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=deepseek/deepseek-v4-flash
# Generate once with: openssl rand -base64 32
ASSISTANT_SETTINGS_ENCRYPTION_KEY=...
SAVIA_MCP_SHARED_SECRET=use-a-long-random-value
```

```dotenv
# infra/secrets/mcp.dev.env
SAVIA_MCP_SHARED_SECRET=use-the-same-long-random-value
```

Restart `pnpm dev`. MCP listens on `127.0.0.1:8789` and the API reaches it at
`http://127.0.0.1:8789/mcp`. In production, configure
`OPENROUTER_API_KEY`, `ASSISTANT_SETTINGS_ENCRYPTION_KEY`, and
`SAVIA_MCP_SHARED_SECRET` as secrets in the GitHub `production` environment.
`ASSISTANT_SETTINGS_ENCRYPTION_KEY` must be a base64-encoded 32-byte key.
Re-encrypt stored keys as part of any planned rotation.

The deployment runs `apps/mcp` as the private `savia-mcp` Worker.
`savia-agencies` calls it through an internal service binding. The API holds
the OpenRouter key. MCP receives only the shared secret.

## License

Savia is developed by Hefesoft SAS, Colombia, under the
[Savia Source-Available License 1.0](LICENSE), which is not an OSI-approved
open-source license. Companies with total monthly revenue above USD 20,000
must obtain a commercial Savia license from Hefesoft SAS. Redistributors must
publish corresponding source, including modifications. All deployments must
preserve visible Savia/Hefesoft attribution.

See the [licensing guide](docs/licensing.md) and [NOTICE](NOTICE).
