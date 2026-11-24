# Public repository operations

The public `hefesoftsas/savia-studio` repository is published from a reviewed snapshot with a new root
commit and neutral author metadata. Historical private branches, tags, data,
local environments, and audit reports are not part of that publication.
Never use `git push --mirror` or `git push --all` from the historical checkout.
GitHub retains references from older pull requests and other copies may retain
earlier commits. A new root for `main` changes the published branch history.

The public workspace includes the SDK, authoring tools, and the
[HTTP echo example](../../store-ports/http-echo/). First-party plugin sources
and hosted provider definitions, contracts, and runbooks are maintained in the
private Savia plugins repository. The hosted release applies the private
compatibility patch before building the workspace. If the patch changes the
frontend inputs, Preview builds the frontend from the assembled sources.

## Continuous integration

CI runs on standard GitHub-hosted `ubuntu-24.04` runners with read-only
permissions. It requires no deployment secrets. Source changes run unit tests,
contract tests, type checks, and publication safety checks. Gitleaks scans the
reachable history; only two exact synthetic test keys are allowlisted. Manual CI runs are available from Actions.

## Preview and production

Preview deploys automatically after successful `main` push CI. Production is
manual-only, requires successful preview for the same commit, revalidates CI,
and waits for the protected production environment approval. Deployment secrets
remain environment-scoped. Preview runtime and Store publication, and
production deployment, compose first-party sources from the revision in
`deployment/hosted-plugins.json` with the tested platform checkout. Update that
revision to promote a first-party release through Preview before production.
The fetch uses the environment-scoped read-only `SAVIA_HOSTED_PLUGINS_SSH_KEY`.
Public CI builds the standalone platform without that key or plugin checkout.
Preview reuses plugin ZIPs already in the workspace catalog when the plugin ID,
version, and SHA-256 all match. Required plugins still run the installation step.
See [preview and production operations](preview-production.md).

Production is currently stopped; its definitions and workflows are retained for
a future rebuild. `PRODUCTION_OPERATIONS_ENABLED` is currently `false` and gates
manual application promotion, production Pulumi dispatch, backup/freshness jobs,
and the standalone production data import. Previously disabled workflows must
also be explicitly re-enabled before use. See
[production rebuild](production-rebuild.md); restoring source does not recreate
the deleted environment or its data.

Historical private branches and tags must not be pushed to the public repository.
External notification webhooks were not duplicated during migration.
