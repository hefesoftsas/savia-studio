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

After a few minutes the job prints the gateway URL plus per-worker status. The
preview deploy includes its own connector gateway worker and encryption secret;
the API binds to that branch worker, and the web gateway gets the preview R2
bucket for office assets.
Log in with `savia.admin@example.test`; the bootstrap password is printed in
the deploy summary (ephemeral per preview, like all its secrets).

## Update individual components from a local checkout

Once the required resources for an isolated branch Preview exist, reuse them for manual
development updates. Run from the checkout containing the changes to test:

```sh
pnpm deploy:preview --branch dev-my-feature web
pnpm deploy:preview --branch dev-my-feature api --apply
pnpm deploy:preview --branch dev-my-feature db api web --apply
```

Omit `--apply` to print the exact targets without Cloudflare credentials.
Before applying, the command checks local and known `origin` branches for
names that resolve to the same Preview. It reports the conflicting names
before contacting Cloudflare.
Applying requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for
the development resources. `web` builds Admin and updates the branch gateway,
`api` updates the branch API, and `db` applies pending migrations to the branch
domain database. A web-only update checks the branch gateway and API Workers.
A database-only update needs D1 access. API updates check the branch gateway,
the API's service bindings and its domain database.
When combined, Workers are built and checked first, then the
database migration runs before API and web are published. Use compatible
migrations so the existing API can continue serving during the update.
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
the web assets from its own temporary output directory.

When applying changes, the command prints each stage as it starts. A failed
command reports the stage, diagnostic category and exit code. To retain raw
logs privately, set `SAVIA_RUNTIME_OPERATION_DIRECTORY` to an absolute path
outside the repository.

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
