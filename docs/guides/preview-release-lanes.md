# Preview release lanes

Shared Preview remains `https://savia-preview.hefesoft.com`. Successful CI for a
push to `main` triggers the existing release workflow. The workflow checks out
the exact tested commit and rejects superseded or foreign-repository runs.

## Compatible plugin updates

The fast lane accepts existing `packages/plugin-*` or `store-ports/*` packages
whose frontend files change with a strictly increased extension version. The
manifest must be identical apart from its version, and store declarations,
dependencies, build settings, permissions and schema must remain unchanged.
Unknown paths or metadata select a complete platform release. Tests-only changes
are checked without publishing another artifact; documentation does not change
the running platform.

CI executes the classifier from the trusted base revision, not the proposed PR
code. Missing trusted code falls back to full checks. The existing **Contract
tests** required check also guards classification and plugin validation failures,
so skipped platform jobs cannot hide an invalid plugin build. Shared code,
dependencies and uncertain changes still run Flows source checks. Pure Pulumi
changes use the infrastructure CI scope described below.

Publication compares the tested commit with the last successful Preview release
ancestor, rather than only its parent commit. Therefore an earlier failed
platform deployment cannot be skipped by a later plugin-only commit. Missing
durable and legacy evidence selects the full lane. A workflow conclusion alone
does not advance the baseline: publication needs a verified component receipt.

The publisher packages only changed plugins and updates their existing enabled
installations. It does not install optional plugins in new workspaces, reactivate
disabled installations, apply migrations, upload secrets, replace Workers, or
copy unrelated R2 state. Before any mutation it verifies live manifest/store
compatibility and writes a durable checkpoint with prior installation and
artifact data. Plugin ZIPs use fixed timestamps and modes so the same source produces the
same digest on retry. It publishes and verifies exact versions and digests. Partial
failure triggers rollback; a concurrent manual disable/version change is not
overwritten. Recovery checkpoints are retained as GitHub Actions artifacts under the
repository’s artifact access policy. They contain plugin source and installation
metadata, but no connector credentials or business documents.

Prior plugin artifacts remain available for recovery. The publisher fails
explicitly when the store quota is full; it never deletes history automatically.
The existing store limit remains ten versions per plugin. Review and archive
inactive versions through the normal management process when needed.

## Full platform updates

Preview builds the Admin and plugin-editor assets concurrently. During that
build it freezes one independent Worker at a time. Workers with assets wait
for the frontend builds. Once the assets are ready, up to two Worker bundles
can freeze at a time. Every build must succeed before the artifact is published.
When `SAVIA_PREVIEW_PLUGIN_EDITOR_ORIGIN` is set, a read-only main-push workflow
can compile both frontends while CI runs. After CI succeeds, Preview accepts
the completed same-repository artifact only for its exact revision, Git tree,
verified frontend origin, toolchain, and file hashes. An unavailable or
mismatched artifact leads to the usual build from source. Preview compiles
Admin and the standalone plugin editor from explicit build settings and skips
dotenv files. The artifact proof includes that policy. The warmup workflow
checks the main push range before installing dependencies. It skips release
tooling and other non-runtime changes, as well as scoped backend-only changes.
Preview still plans from the last verified deployment. If an earlier change
needs frontend assets, the deploy job builds them from source when a warm
artifact is unavailable. The warmup workflow receives no deployment credentials.

The complete lane preserves the established write pause, drain, Durable Object
snapshot, coherent D1/R2 backup, encrypted archive, infrastructure, migration,
Worker publication and recovery sequence. Production promotion remains separate.
Preview stages secrets for up to two independent Workers at a time and waits
for all uploads to succeed before deploying the new versions.
The existing production gate still requires the full **Deploy preview** job; a
plugin-only Preview publication alone does not authorize production promotion.

### Retrying a failed Preview deployment

The workflow retains the frozen Preview runtime bundle as a seven-day encrypted
Actions artifact. A rerun can reuse it only from the same workflow run, tested
main SHA, Preview environment and Cloudflare account. The workflow requires one
unexpired artifact with matching run provenance, decrypts it with the existing
backup key, rejects unsafe paths and links, and verifies the release manifest,
source revision, Worker identities, artifact digest and config digest. It also
rerenders the current Preview Worker configuration and checks its fingerprint,
including the plugin-editor URL and the Flows frontend build setting when the
release includes the gateway. If configuration has changed, the workflow
rebuilds and replaces the same-run bundle; a missing or expired bundle also
causes a rebuild. Corrupt, ambiguous or identity-mismatched artifacts fail
closed. Older runs made before this retention step have no bundle to reuse.

Every retry still checks the current main SHA, infrastructure outputs, Flows
preflight and isolated Preview resources, then creates a fresh Pulumi preview
and saved plan against the current checkpoint before applying. Runtime secrets
come from the current protected Preview environment. The previous attempt's
saved plan, Pulumi state and checkpoint are never restored or replayed.

D1 table dumps start with bounded row pages and halve a page only when Cloudflare
returns its explicit 50 MB response-size error, retrying the same offset until
the page succeeds or reaches one row. A dump that still fails is discarded and
cannot be treated as a successful backup; the release stops before data
migrations and Worker publication. The write pause and drain may already have
started, so the existing failed-release recovery sequence remains necessary.
Public command errors report only a safe diagnostic category, remediation code,
operation and exit code. Raw command diagnostics remain encrypted for seven days
and are not printed to the workflow log.
The command journal preserves these codes through the lifecycle wrapper.
`DNS_RESOLUTION_FAILED` identifies an explicit DNS lookup failure; verify the
public hostname resolves before retrying a release that failed its health check.

After Preview writes are quiesced, the full release exports the Flows Durable
Objects while it captures Auth D1, Domain D1 and the documents bucket.
Flows D1 and the Flows resources bucket wait for the export to finish so
they include flushed workflow edits and the snapshot pages. The Preview D1
fallback reads up to four tables at a time and
streams their SQL into the original table order. Capture failures wait for
active work to settle before recovery. The backup manifest is published only
after every capture and integrity check succeeds. Production retains serial
capture and its verified recovery boundary.

Set the GitHub Actions environment variable `SAVIA_PREVIEW_BACKUP_ENABLED` to
`false` in the `preview` environment to omit the data backup for managed Preview
releases. An unset variable or `true` enables the backup. The release still
pauses and drains Flows, runs migrations, and verifies deployment health. Without
a data backup the release has no fresh recovery archive for D1, R2, or Flows
data; Worker version recovery remains available. Production uses its own
`SAVIA_PRODUCTION_BACKUP_ENABLED` variable in the `production-app` environment.
The standalone production backup workflow has its own independent configuration.

When the Preview API already has the environment-scoped
`SAVIA_BACKUP_CONTROL_SECRET`, the managed release can verify its drain.
It first verifies that the serving API accepts the credential and checks for
pending writers without acquiring a lease. Preview sends the probe and lease requests over a temporary private
service binding restricted to the write-control endpoint. The API still checks
the environment-scoped credential. The release then pauses the API and Flows,
waits for zero active Flows runs, and acquires
the renewable storage lease from the Preview control endpoint. The controller
verifies the shared gate across API, Auth, Request and Connectors. The release
holds the lease during capture, verifies it again, then releases it before
continuing. A denied or lost lease stops the release before migrations.
If access cannot be proven, the release uses the fixed drain and full capture.
Pending writers or a lease held by another owner stop the release before the
pause. The final Preview API deployment attaches
the credential directly to its version using a private, temporary secrets
file. The timing summary identifies the probe outcome.

When writers are pending, dispatch **Inspect Savia Preview backup gate** on
`main`. This job is serialized with Preview releases and reports the count and
creation times of outstanding permits. Use these times to correlate with Worker
and storage operation records. A permit's age is insufficient proof that its
operation finished. The diagnostic keeps permit IDs and credentials private and
does not remove permits.

The historical Preview cleanup workflow is limited to the reviewed set of 533
permits through November 23, 2026 UTC. It uses a private temporary Worker and
retains an encrypted archive before closing the exact permit IDs. A different
set or an active backup lease stops the operation before any permit is closed.

The deployment timing summary includes D1 export and fallback, R2 listing and
copy, and integrity hashing. These timings overlap and are included in the
parent backup duration.

The managed Preview release downloads up to eight R2 objects at a time over
reused HTTPS connections. Each signed download matches the listed ETag and
verifies the response size and raw bytes written before recording the object.
Standalone backups default to four concurrent workers. Set `--r2-concurrency 1`
through `--r2-concurrency 8` on `infra/pulumi/backup.mjs` to adjust the bound.
An error stops new downloads and waits for in-flight downloads before failing;
no successful backup manifest is produced. Partial files may remain in a failed
backup directory and are not evidence of a restorable snapshot.

## Infrastructure CI scope

CI uses an opt-in classifier separately from publication planning. Changes only
under `infra/pulumi/`, with optional files under `docs/` or `documentation/`, skip
application unit/typecheck jobs and Flows source verification/unit/typecheck jobs.
Pulumi's PR workflow still runs every infrastructure helper test, all four program
typechecks, and the real CLI preflight. The existing **Contract tests** required
check retains the full repository contract suite and adds the Flows offline
maintenance/recovery tests for this scope. Public source security checks remain
active.

Flows API tests run in two independent Vitest file shards. The first shard also
runs the Node tests for the container helpers. The root/native suites, the
app/runtime/geo/utils suites, and the types/recovery checks run alongside the
API shards. The **Flows runtime and preview readiness** check requires all
five jobs to succeed. Infrastructure-only runs skip this group.

Mixed application/infrastructure changes, shared code, dependencies, workflow or
classifier changes, unknown paths, and unreadable revision ranges select full CI.
The workflow executes the classifier from the trusted base. An older classifier
without the CI option also selects full CI, allowing the first upgrade PR to be
validated normally. A shorter CI selection does not change the release kind:
infrastructure changes still require a platform publication through existing gates.

Auth-only changes may also use a focused profile when they touch Auth source or
tests, the explicitly listed Auth deployment helpers and their tests, and the
preview Auth workflow; documentation may accompany them. This profile runs Auth
tests, all three deployment-helper test files, and Auth typechecking. Shared code,
dependencies, other workflows, unknown paths, or mixed scopes restore full CI and
Flows checks.

Before submitting infrastructure changes, run `pnpm infra:preflight` with the
repository-pinned Pulumi CLI and installed `infra/pulumi` dependencies. See the
[ownership runbook](../runbooks/pulumi-environment-ownership.md#local-cli-preflight)
for its isolation guarantees and the separate live read-only audit.

## Operations and measurements

Use one Actions watcher and verify the final tested commit, release kind,
artifact digest and enabled installation. Measure CI, publication and feature
development separately. A two-to-five-minute artifact publication is an
optimization target, not a guarantee for every feature or a replacement for
complete platform checks.

For coherent backup and failed-release recovery details, see
[Preview and production operations](../runbooks/preview-production.md).

## Preview code updates

Existing application source changes can publish only the affected API, Auth,
MCP, Request or Connector Gateway Worker. The shared assistant API client
selects both MCP and API, and publication updates MCP before API. Existing Admin TSX/CSS and TypeScript
localization sources can use the frontend-only lane described below. Other Admin
source and configuration changes retain the full lane. Scope is resolved before build
preparation: a verified source-only release bundles only the selected Workers
and skips unrelated Admin and plugin-editor builds. The frozen artifact digest
also covers the exact base, head and selected targets in `release-source.json`.
The artifact's configurations must match those targets exactly. Pulumi retains
the complete existing managed Worker inventory; an omitted unchanged Worker
is not a deletion. Each selected binding is still checked against that full
inventory and its reviewed data identities. Planning uses the last
successful evidence-backed deployed ancestor, so a failed release cannot hide
pending changes. Missing history, new/deleted files, schema statements, entrypoints,
configuration, dependencies, migrations and unknown paths select the full release.
Production always uses the complete publication sequence.

The frontend-only lane builds Admin assets and the isolated plugin-editor bundle
because they share UI source. It freezes only the `pluginEditor` and `gateway`
targets, publishes the editor before Admin, and verifies public health and editor
isolation. The frontend pair must always be complete. Frontend-only releases
publish just the pair. Retries validate both frozen configuration dependencies and the plugin editor
origin. No backups, migrations, secret publication or Auth initialization run.

Frontend CI runs all six weighted Admin shards, Admin type checking, contracts
and source-safety checks. The required gate requires all six shards and type
checking to succeed. Dependency changes, arbitrary TypeScript utilities, edge
gateway source and build configuration retain full CI and full publication.
Mixed frontend and eligible API or MCP edits publish the selected backend
Workers with the frontend pair through the code-only route. When the backend
files fit the existing assistant API profile, CI runs the complete Admin and
assistant API/MCP gates together. Other backend files can require full CI.
Mixed frontend changes involving other backend Workers require full publication.
Unknown previous file contents and additions or deletions also require full
publication even when focused frontend tests are appropriate.

Changes limited to the release publisher or the temporary maintenance relay run
through CI. Preview keeps serving its current Workers and skips the data backup.
Changes to the deployed Flows maintenance API require the managed release. The
next applicable release uses the updated publisher and relay from tested main.

Measure a label-only push separately from installing this workflow: the trusted
base classifier needs the workflow changes on `main` before it can select the
frontend profile. Measure until the label is observed in the live browser, not
only until GitHub reports publication success.

This preview-only path requires an active runtime. It skips write pauses, Flows
snapshot/drain, data backups, migrations and secret publication. Auth publication
still completes deployment initialization before dependent Workers. Existing
health checks and Worker version recovery remain mandatory. Code-only preflight
requires an active deployment and skips bootstrap. The release captures fresh
serving versions and Durable Object identities before publishing. Code-only recovery
never restores databases. Missing or inconsistent scope metadata fails closed;
a partial artifact cannot be used as a full release. Entrypoint and schema
changes still require the full lane, including Auth's `src/index.ts`.

Full Preview publication overlaps at most two independent Worker deployments.
Auth publication and initialization finish first. Hook Executor precedes Request
and Flows, Request precedes Connectors, and the API follows its providers.
Each Worker can start as soon as its own prerequisites finish. For example,
Flows can publish while the plugin editor is still being published or verified.
Both the editor readiness check and the API's providers finish before the API
is published.
The public gateway is published last. A failed publication waits for all
in-flight sibling commands to settle before rollback begins. Production and
unrecognized publication steps retain serial execution. Backup, migration,
namespace preservation and health-check boundaries remain unchanged.

The deployment's **Publish sanitized runtime operation timings** step reports each release
phase and supported command with elapsed milliseconds and success/failure,
including failed releases. Phase times include their nested commands and must
not be added to command durations. Parallel command durations can overlap.
Only fixed operation labels, durations and outcomes are published; command
arguments, subprocess output, environment variables and error contents remain
private. Records are best-effort and unavailable records do not block recovery.
The summary runs only during a deployment; it adds no scheduled monitoring.

Isolated Auth and API changes use their focused CI profiles. API changes also
regenerate and typecheck Admin API clients to validate frontend consumers. Shared backup-gate
changes test all four consumers. Mixed and uncertain changes retain full checks.
The assistant API profile covers the API assistant source, MCP and the shared
assistant API client. It requires all API shards, the MCP suite, the shared
client and MCP type checks, API and Admin type checks, and assistant consumer
tests. Focused API and assistant API profiles run six Vitest file shards and
one native backup-gate check. Full CI uses the three standard API shards. Other
shared code and unrelated mixed changes retain full validation.

A push to `main` may reuse CI from a merged same-repository pull request for
changes to application source and tests, Pulumi scripts and tests, the Auth
initialization helper and its tests, and the named Admin frontend build paths
in `scripts/preview-ci-reuse.mjs`. Changes to those build paths also require
all six Admin test shards and the Core and Apps type check to pass in the PR.
CI compares GitHub's associated PR and successful workflow attempt
with the exact Git tree and first parent recorded by a step in the PR
classification job. That attempt must complete both contract jobs successfully.
Missing evidence, changed workflow or dependency files, and a different base
or tree run the usual validation. Public source safety still runs on `main`,
and publication still requires a successful `main` workflow run.
Office assets and workspace store plugins publish only when their cumulative
paths changed; a missing baseline enables both conservatively.

Cloudflare API reads retry transient 500, 502, 503 and 504 responses up to three
times with 1, 2 and 4 second backoff. Failed response bodies are canceled before
waiting. Mutations are not retried for these server errors; existing 429 handling
continues to honor `Retry-After`. Network errors are returned without retry.

Full releases stage secrets with `wrangler versions secret bulk` before publishing
code, allowing retries after rollback leaves a newer inactive Worker version.
If Wrangler exits before sending the Auth initialization request, the Auth
helper starts a fresh session once. After it sends the request, the helper
requires a readiness response for the deployed revision. Startup has a separate
row in the CI timing summary. The private encrypted diagnostics artifact
contains bounded subprocess output from failed attempts.

## Independent Preview component retries

Preview records runtime, Office and complete store-catalog publication separately.
Each receipt is bound to an exact trusted main workflow run and a successful
component job. A later asset failure cannot invalidate successful runtime work.
The aggregate `preview-release` receipt is emitted only when every required job
succeeds; partial releases never qualify as full promotion evidence.

Use GitHub Actions **Re-run failed jobs** to retry a failed component. Successful
runtime and Office jobs are retained, so retrying store publication does not run
Pulumi, pause the application, export databases or copy R2 objects again. Store
publication waits for selective plugin publication to avoid concurrent catalog
writes. Pending asset changes are compared with their own last successful
component baseline, even when runtime has advanced since the failure.

The planner can adopt a previous combined release's successful runtime operation
only with exact-run immutable artifact evidence, successful resource isolation
and supersession guards, and a successful managed apply. Successful Office upload
can be adopted independently. A failed or incomplete apply is never a baseline.
Unknown history still fails closed to the full release lane.

For verified compatible code changes, the existing Preview-only code lane skips
maintenance, backups, migrations and secret updates. Schema/configuration or
unknown changes retain the full recovery path. Known orchestration-only and
asset-only changes do not republish unchanged Workers.

The Preview store job opts into preserving newer optional catalog versions. It
preflights all workspace catalogs before uploading: a newer optional version is
left untouched and is never installed automatically; a newer required version
blocks publication. Same-version packages still undergo the server's exact-content
check, and a conflicting HTTP 409 remains a failure. Production does not enable
this policy. No scheduled jobs, pings or background polling are introduced.

Verified code-only artifacts retain only the configuration dependencies of their
selected Workers. In particular, retaining or restoring an Auth-only artifact
does not query or export the plugin-editor URL. Full releases still fingerprint
that URL and reject reuse when it changes. Known Preview planning/custody tooling
changes can accompany a compatible code update without forcing a data backup;
unknown infrastructure, Worker configuration and schema changes still select
the full path. Changes limited to infrastructure plus the named Preview planning
helpers run the infrastructure contract profile, including offline recovery tests.

## Evidence independent of Actions retention

Preview also stores successful component receipts in GitHub Deployments, using
the existing `preview` environment and dedicated `savia:preview:component:*`
tasks. Each receipt includes the exact main SHA, repository, component and
workflow-run identity. A successful status is written only after publication;
the complete-release receipt requires all applicable jobs to succeed. It can
represent unchanged component equivalence without claiming a new Worker version.

These records survive deleting workflow runs and artifacts. Planning reads them
before legacy Actions evidence, checks identity and git ancestry, and retains
independent runtime, Office and store baselines. Automatic environment
inactivation does not erase an earlier successful publication; a failed or
incomplete receipt cannot establish a baseline. An unavailable receipt API stops
planning rather than forcing a full deployment and backup. Explicitly deleting
the deployment records still removes this evidence; keep them when cleaning CI.

Receipts contain only release metadata. They add no storage service, secret,
scheduled workflow, ping or polling task. Only publication jobs have deployment
write permission. The initial completed release was recovered from preserved
local job evidence cross-checked against the surviving successful environment
deployment; normal runs write receipts automatically. Existing encrypted retry
artifacts retain their previous expiration and are not replaced by receipts.

## Concurrent contract validation

The **Contract suite** job starts after successful change classification, in
parallel with plugin validation and focused Auth/API/runtime checks. The existing
required **Contract tests** check remains the final gate. It requires the suite
and classification to succeed, plus each applicable plugin or runtime lane;
failed, cancelled and unexpectedly skipped prerequisites cannot pass the gate.
This changes scheduling, not the required validation coverage.

## Bounded Preview infrastructure reads

Preview snapshots read at most four independent Worker chains concurrently. Each
chain still verifies the native identity, fully serving deployment, version
bindings, execution policy and schedules in order. Results retain input order;
a failure stops new reads and settles in-flight requests before returning an
error. Production and other environments retain serial Worker reads.

Preview account inventory reuses service and foreign Durable Object dependency
names from those same serving-version bindings, avoiding a second script-settings
request for every deployed Worker. It returns only validated dependency names;
secrets and variable values stay inside the client. Every plan and apply still
reads a fresh inventory and checkpoint catalog; nothing is cached across them.
The Preview catalog exports up to four independent stacks at a time, retains
catalog order, and completes each batch before returning an export failure.

Preview release preparation batches its public managed configuration into one
`pulumi config set-all --json` command after hydration and preparation. The final
value of a repeated key wins, matching sequential writes. Applied configuration
refresh, secret rejection, bootstrap-proof removal, unrelated config keys and
production's individual writes are retained. A failed batch stops before preview.
The pinned CLI was checked against individual writes in an isolated file backend,
including empty values, JSON strings, newlines, equals signs and an existing
unrelated encrypted secret.

Sanitized timing summaries now separate environment inventory, configuration,
stack catalog/export, Pulumi preview and apply. Only fixed labels, durations and
outcomes are recorded. CLI arguments, credentials and subprocess output are never
included. Inventory and command durations may be nested within workflow step
measurements and must not be added to those parent step durations.

The existing Pulumi `--refresh --run-program --parallel 1` policy, complete
ownership checks, saved-plan digest and checkpoint fingerprint checks remain in
force. Deployment-only inventory/configuration helpers can accompany a compatible
Auth code update without forcing backups; Worker configuration and schema changes
continue to select the full release path.

## Security analysis and optional coverage

**CodeQL security** runs on pull requests targeting `main` and manual dispatch.
It replaces GitHub's default setup: there is no automatic scan on a main push
and no weekly scan. The selector uses all changed PR paths, including the old
path of a renamed file, to select Actions, JavaScript/TypeScript, Python and Rust.
Each selected language still analyzes the complete repository. Documentation
and image changes alone skip analysis; unknown files and changes to the scanner
controls select all languages. A newer run cancels the superseded run for that PR.

Selection runs trusted base-branch code and checks the PR revisions before and
after reading the paginated file list. API errors, changed revisions and file
lists beyond the supported limit fail selection instead of silently skipping a
scan. No deployment secrets are used.

Use **CodeQL security → Run workflow → language: all** for a complete baseline,
including after direct pushes to `main` that bypass PR analysis. A single
language can be selected for a focused manual check. This removes duplicate
scans; it does not promise a shorter analysis of a given language. CodeQL is
separate from the Preview deployment gate.

**Coverage** is manual only. Required CI tests remain automatic. Changes limited
to these security/coverage workflows and their selector do not publish Preview
runtime or assets. Neither workflow adds Cloudflare schedules, pings or polling.

## Focused automation validation

Set the repository's GitHub Actions variable `SAVIA_CI_FLOWS_ENABLED` to `false`
to skip the dedicated Flows test, type-check, recovery, and readiness jobs in
Savia CI, including the Flows-only recovery step in infrastructure CI. Set it
to `true` or remove it to use the normal change classifier. Core contract checks
continue to run when required by the existing CI profile. With the same
variable set to `false`, Preview publishes the core runtime and keeps the
existing Flows Worker, bindings, and data in place. Preview skips bundling the
Flows Worker, as well as Flows maintenance, migrations, and publication.
The release plan keeps the existing Flows Worker in the verified ownership
profile even though the release artifact omits that Worker. Preview continues
to verify the deployed Worker identity and version without querying its
execution policy database when Flows is disabled.
New Preview frontend builds omit the embedded Flows editor and hide its menu
entry. Saved links show its availability without loading the editor. Preview
only reuses prepared assets built with the same setting. Production uses its
own deployment settings.
The exact-tree CI proof includes the Flows setting so a run can only be reused
under the same policy.

Set the Preview environment variable `SAVIA_PREVIEW_STORE_EXCLUDED_TENANTS`
to a comma-separated list of `tenant:<id>` scopes to exclude selected
workspaces from automatic store publication. This applies to full and
selective Preview releases. Workspace administrators can still install
packages through their configured catalog.

The `ci-config` profile runs the contract suite and public-source safety checks
for the exact orchestration allowlist in `scripts/preview-change-plan.mjs`.
It includes the CI, Preview, CodeQL and Coverage workflows and named release and
security selectors. It does not include arbitrary workflow or script directories.
Classifier and required-gate edits, dependency files, test-distribution helpers,
unknown files and mixtures with application changes retain full CI.

Classification still executes the base revision's trusted script. Introducing
a profile therefore runs the previous profile on that first push; subsequent
eligible pushes use the new profile. A missing or unsupported result falls back
to full CI. The required Contract tests gate rejects failed, cancelled, skipped
or missing contract results, including for `ci-config`.

Full CI splits Flows core into two independent jobs: policy verification plus
integration/native tests, and app/runtime/geo/utils tests. Generated integration
builds stay in their original job. The aggregate Flows gate requires both jobs,
both API shards and readiness checks to succeed. All seven package suites remain.

Admin keeps six jobs and one test worker per job. A custom Vitest sequencer
distributes the complete discovered test list by advisory historical file costs
in `scripts/admin-test-durations.json`. The initial estimates use the successful
2026-11-06 CI run plus a fixed per-file setup allowance. Missing measurements get
a default cost, and obsolete measurements do not add or remove tests. Assignment
is deterministic and every discovered test belongs to exactly one shard. These
estimates affect scheduling only; refresh them when timing imbalance returns.

The Admin sequencer is enabled only by CI command arguments; normal local test
commands and application builds are unchanged. Changes to CI helpers do not
publish Preview application components.

The first full CI measurement on 2026-11-06 completed in 4m21s versus 5m07s for
the preceding full run. Flows core's longest test step fell from 3m57s to 3m01s;
the longest Admin test step fell from 3m23s to 2m56s. The complete push-to-Preview
check took 4m49s, with every application publication job skipped. These are
individual observations, not an application deployment benchmark or a guarantee.
Flows adds one parallel runner; focused automation changes avoid the full set of
application runners. Runner-time cost and elapsed time should be tracked separately.

## Event-driven PWA activation

The private bootstrap mounts the deployment observer before registering the
service worker, including while the private application is loading. When a
replacement controller takes over, a visible, online, safe view reloads once
from its installed shell. The first worker claim does not reload the document.
Version checks and pending reloads use Savia's shared connectivity check when
the browser reports offline. The private view shares registration across
remounts while it is pending. Closing the view releases its update listeners
and any connectivity check it owns.
Updates are discovered by normal registration and the existing visibility and
reconnection events (at most one explicit check per minute); no periodic check,
heartbeat, deployment socket or cron is added. A continuously visible idle tab
is not guaranteed to discover a deployment immediately.

Open forms, textareas, editable content, embedded apps, dialogs, busy regions,
edited controls still mounted in the document, and existing unload guards defer
automatic reload. Closing the editor or leaving the edited view allows the
pending update to apply. Collapsing a details panel releases untouched fields
from this check. An editor or form field that overrides inherited CSS visibility
keeps the same protection while visible. Edited controls remain protected while
mounted. Weak references let the browser reclaim detached panels. Saving alone
does not prove an arbitrary custom editor is safe. The explicit update action
remains available. A DOM observer watches only while an update is pending and
makes no network requests. Storage,
credentials, synchronization queues and public-route behavior are unchanged.

Rollout verification requires two releases: load the new update handler first,
then publish a frontend label change while that document remains open. Returning
to the tab should discover the replacement and show its label without a manual
reload or cache-busting navigation. An already open document running the old
handler needs its existing update action once to adopt this behavior.
