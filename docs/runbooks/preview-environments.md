# Preview environments (temporary, one-click)

Spin up an isolated copy of the stack for a branch, test it, then destroy it.
Nothing is shared with production: fresh D1 databases (migrated), a fresh R2
bucket, ephemeral secrets, and `*.workers.dev` URLs (no custom domain).

Infrastructure declarations live in `infra/pulumi/branch-preview/` and
`infra/pulumi/branch-preview-worker-config.mjs`. Each branch uses a separate
`branch-<slug>` Pulumi stack in the configured remote R2 backend. Existing exact
branch D1/R2 resources are adopted before applying; deployments never silently
replace them with a fresh state. Install the pinned Pulumi CLI and run
`npm ci --prefix infra/pulumi --ignore-scripts` locally. Set `PULUMI_BACKEND_URL`,
`PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` in
addition to Cloudflare credentials. GitHub uses the preview environment secrets
described in [the infrastructure runbook](pulumi-infrastructure.md). Dry runs
stay credential-free and never create a stack.

## One-click deploy

GitHub Actions → **Preview environment** → Run workflow:

- Run the workflow from `main`. This workflow definition skips dispatches from
  other refs.
- `branch`: a non-production branch whose tip is already an ancestor of the
  workflow commit on `main`. Unmerged or squash-merged branch tips are rejected.
- `action`: `deploy`

Before installing dependencies, the workflow validates the branch name, fetches
its exact head, and checks that the commit belongs to the approved `main` history.
It then checks out that immutable commit. The ancestry check prevents an
unmerged branch from supplying the selected preview branch source to this
workflow's privileged deployment. Supporting unmerged previews requires a
separate build pipeline without infrastructure credentials.

Before creating a branch Preview, set `SAVIA_BRANCH_PREVIEW_BOOTSTRAP_PASSWORD`
in the GitHub `preview` environment to a password of 12 to 128 characters.
For a full branch deployment from the CLI, supply it in the environment as
`BETTER_AUTH_BOOTSTRAP_PASSWORD`. Use `savia.admin@example.test` and that
password for the first sign-in. The deploy sends the password to the branch
Auth Worker as a secret. Later updates preserve the branch's existing credentials.

After a few minutes the job prints the gateway URL plus per-worker status. The
preview deploy includes its own connector gateway worker and encryption secret;
the API binds to that branch worker, and the web gateway gets the preview R2
bucket for office assets.

## Update individual components from a local checkout

Once the required resources for an isolated branch Preview exist, reuse them for manual
development updates. Run from the checkout containing the changes to test:

```sh
pnpm deploy:preview --branch dev-my-feature web
pnpm deploy:preview --branch dev-my-feature api --apply
pnpm deploy:preview --branch dev-my-feature auth --apply
pnpm deploy:preview --branch dev-my-feature request --apply
pnpm deploy:preview --branch dev-my-feature db auth request api web --apply
```

Omit `--apply` to print the exact targets without Cloudflare credentials.
Before applying, the command checks local and known `origin` branches for
names that resolve to the same Preview. It reports the conflicting names
before contacting Cloudflare.
Applying requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for
the development resources. `web` builds Admin and updates the branch gateway,
`auth` updates the branch Auth Worker with its existing Auth database and
credentials, `request` updates the private Savia Request Worker, `api` updates
the branch API, and `db` applies pending migrations to the branch domain
database. A web-only update checks the branch gateway and API Workers. An
Auth-only update checks the branch Auth database, the branch gateway and the
API service binding. A Request-only update checks the existing branch gateway,
domain database and Hook Executor, and preserves the Request Worker's secrets.
A database-only update needs D1 access.

To recover a branch published without its initial Auth password, supply
`BETTER_AUTH_BOOTSTRAP_PASSWORD` in the local environment and run
`pnpm deploy:preview --branch dev-my-feature auth --restore-auth-bootstrap --apply`.
The Auth deployment attaches the missing secret and uses the configured
bootstrap email, or `savia.admin@example.test` if the email binding is absent.
An existing password binding is preserved. Sign in after the update to let
Auth initialize the branch's administrator and OAuth clients.
With `--restore-auth-bootstrap`, the command verifies the password binding again
before publishing Auth. If the update also selects `db`, it makes the same
check before applying migrations. A change in the binding stops the update.

API updates check the branch gateway, the API's service bindings and its
domain database. An update that includes `api` or `request` without `db` reads
the domain migration history before building Workers and again after
validating them, before publishing. The check only needs the D1 Read
permission for the [D1 query endpoint](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).
If migrations from the checkout are pending, include `db` in the update.
If the database has applied migrations missing from the checkout, the check
stops before building Workers. Use the matching checkout for that branch
database or reconcile the verified schema before continuing.
When an update includes `db` and Workers, it first reads the domain migration
history. A compatible history with pending migrations can proceed. An applied
migration missing from the checkout stops the update before any Worker builds.
After Admin passes type checking, the selected Auth, Request, and API
Workers prepare while the Admin assets build. The gateway waits for the
assets. Concurrent builds check installed dependencies without repairing
them. If the dependency check fails, run `pnpm install` and retry the update.
After the selected Workers compile and start locally, the command rechecks
the history, applies pending migrations, and publishes Auth, Request, API and
web in that order. Use compatible migrations so the existing API can continue
serving during the update.
Each D1 request has a 30-second deadline that includes reading the response.
If a request times out, the update stops before publishing Workers. Running the
update again reads the migration history before applying any pending files.
The migration runner requires a successful result for every statement in the
D1 batch, including its migration-history entry, before reporting success.
If D1 rejects a batch after another update records the same migration filename
in the history, the runner continues with the remaining files without replaying
the committed migration.
If Cloudflare returns an unreadable or non-JSON response, the runner reports
the HTTP status and the affected operation without printing the response body.

These updates run directly from the current checkout, including uncommitted
changes. They do not run CI, deploy Flows, provision infrastructure, or touch
shared Preview and Production. Use a complete managed branch deployment for
changes to other Workers or infrastructure, and use the CI-gated path for releases.
Changes to the manual update command still run through CI. Once there is a
verified deployment baseline, updating only the manual command leaves shared
Preview running its current release.

The manual web build ignores checkout-specific Vite environment files so the
deployed page uses its own Preview API. It also skips building and packaging
the embedded Flows editor. Each manual update builds, verifies, and publishes
the web assets from its own temporary directory. It copies the static files
into that directory, builds the VS Code extension in private staging, and adds
the verified VSIX and checksum to that copy for Vite.
The gateway runtime contract starts the configured Worker entry and checks
tenant forwarding and downloadable extension assets.

Shared and branch Preview use the same routes through the gateway for
public shares and service worker scripts. Public pages receive
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and
`X-Robots-Tag: noindex, nofollow`. The service worker scripts use
`Cache-Control: no-store` so browsers can discover a new web build.

The command bundles each selected Worker once and starts the bundles in a local
Workerd instance with the configured compatibility flags. A startup failure stops
the update before it applies migrations or publishes Workers. On success, the
command publishes those same bundles.
The database check and migration use a temporary copy of the SQL from the
start of the run. If the migration files
change while the API is being prepared, the command stops before applying
migrations or publishing Workers. Edits after the API has been prepared are
picked up on the next run.

When applying changes, the command prints each stage as it starts. A failed
command reports the stage, diagnostic category and exit code. If an update
fails after earlier components succeed, the error lists those completed
components. Inspect the active deployment if the failed Worker's publication
status is uncertain. After resolving the failure, select the remaining
components from the same checkout to retry. An API or Request retry without
`db` checks the database migration history against the checkout before publishing.
To retain raw logs privately, set `SAVIA_RUNTIME_OPERATION_DIRECTORY` to an
absolute path outside the repository.

## One-click destroy

Same workflow, `action: destroy`, `confirm:` set to the exact branch name.
Without a matching confirm the job refuses. Destroy runs the scripts from the
trusted workflow commit on `main`; the target branch may already be deleted.
The branch name identifies resources and is never inserted into shell source.
Destroy deletes the 7 workers,
both D1 databases, and empties + deletes the R2 bucket through the branch Pulumi
stack. A missing/mismatched stack or deletion failure stops the job; the shared
state bucket and plugin registry are never targets.

Local equivalents:

```sh
node scripts/preview-deploy.mjs --branch feat-x [--dry-run] [--skip-admin]
node scripts/preview-destroy.mjs --branch feat-x --dry-run
node scripts/preview-destroy.mjs --branch feat-x --force
```

## What a preview is (and is not)

| Aspect                | Preview                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Workers               | Branch-specific auth, request, hook executor, connector gateway, MCP, API, and web gateway workers; the web gateway uses `workers.dev` |
| Data                  | fresh D1s with all migrations applied; empty R2 bucket                                                                                 |
| Secrets               | random per preview (connector encryption key and MCP secret shared with the relevant workers)                                          |
| Runtime bindings      | branch-only connector service, realtime and WhatsApp Durable Objects, and rate limit namespaces                                        |
| Cron                  | Disabled by default; `--enable-schedules` opts into the every-minute tick                                                              |
| Provider live keys    | not configured (Nango/OAuth flows fail gracefully)                                                                                     |
| savia-request sandbox | Private branch-specific QuickJS hook executor; no WorkerLoader binding                                                                 |
| D1 budget             | Two D1 databases per preview; check available account capacity                                                                         |

## Safety rails

- `main`/`production`/`staging` (and case variants) are refused by the
  scripts; destroy only touches names containing `-preview-<slug>` and
  requires `--force` (CLI) or matching `confirm` (workflow).
- Previews never read or write production databases, buckets, or secrets.
- No TTL automation: whoever creates a preview destroys it. Stale previews
  are visible as `*-preview-*` workers/databases in the dashboard.

### Opt-in scheduled background jobs

Local branch previews keep cron disabled by default. For an isolated preview that
must run scheduled workflows, plugin monitors and notifications while browsers
are closed, pass `--enable-schedules` to `scripts/preview-deploy.mjs`. The API
worker then receives a one-minute trigger; each monitor enforces its own due time
(e.g. hourly). Only enable this on the intended isolated preview. Preserve its
existing encryption secrets and OAuth grants when updating an already configured
API Worker; rerunning a complete ephemeral bootstrap rotates its secrets.
