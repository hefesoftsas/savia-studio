# Tenant-only workspace isolation

Studio uses `tenants.id` as its sole data-isolation identity. The authorized
workspace catalog is `GET /v1/tenant-workspaces`. Each entry contains a numeric
`tenantId`, an `id` of `tenant:<id>`, a label, a kind, and an API base path.
Tenant selectors are omitted when there is exactly one authorized choice.
With one tenant, screens use it automatically and omit the selector and its
helper text. Explicit unauthorized Studio URLs still require recovery to the
authorized workspace; hiding the selector does not grant access. Savia Request
platform administrators retain the shared-catalog choice alongside tenant scopes.

Savia Request sends canonical `tenant:<id>` scopes for every operation, including
bulk secret export and import. Older UI selections using `agency:<id>` are read
as the same tenant and rechecked against the user's memberships; they are never
sent to the API. Empty scope remains the platform-only shared catalog.
The platform tenant picker keeps its list in memory for the current API client
and authenticated session. It clears previous options while a new list loads,
and pending responses cannot refill the picker during logout.
Changing tenants or sessions, or leaving the bulk secrets screen, discards the
import preview and prevents pending exports from downloading. An import already
submitted to the server can finish in its original scope.

An empty masked variable preserves its saved secret. Supply a value when changing
the Secret checkbox for a configured variable, including an inherited default.
A new secret field can be saved empty and configured later. An empty tenant
secret can inherit a platform secret when that key has one. The editor waits
for changed variables to save before switching flows. Savia commits the flow
definition and variable changes together. If the save fails, the editor keeps
the draft for correction and retry.
Validation errors explain which field or step needs attention before the flow
or any accompanying variables are saved.
If the navigation refresh fails temporarily after a successful save or reload,
the editor keeps the confirmed flow and updates its entry in the list. A denied
read clears workspace data even when another navigation request has already
reported a temporary failure.
After saving, Savia masks the secret again and displays the persisted variable
configuration. Typed secrets stay in the active draft until acknowledged.
In-memory navigation snapshots exclude secret values.
Renaming a configured secret requires a value for the new key. The editor
keeps the original on the server until you supply a value and save.

Running a request sends the operation input with that run. Save the flow
explicitly to keep those values as its default input or to declare new input
keys. Restore flow input returns the operation editor to the input defined by
the selected flow.
Flows open in simulated mode by default. Real mode applies to the current
selection, and opening a result from history keeps the selected execution mode.
The DANE catalog lookup uses real mode because it reads the official catalog.
Changing the flow, route, or session closes pending deletion confirmations.
A deletion confirmed before navigation may finish on the server. The editor
keeps the current selection when that earlier response arrives.
Savia Request offers to create the first flow once the catalog confirms it is
empty. If the initial catalog or selected flow fails to load, Retry reloads
the current selection.
When flow creation reports a failure, retrying checks for the same flow before
writing again. After creation is confirmed, retrying a catalog load opens the
created flow.
After duplicating a flow, Savia Request opens the confirmed copy. If loading
fails, retry the selection to reopen that copy. A tenant copy lists inherited
platform secrets as empty fields so you can configure tenant-owned values.
Restore is available for flows and variable overrides with a platform default.
Saving a tenant copy marks it as customized in the editor as soon as the write
is confirmed. Restoring a flow clears temporary operation input and loads the
platform version directly. After a confirmed flow or variable restore, if
loading the updated flow fails, retry to reopen it for editing. A restore that
finishes after changing flows leaves the new selection and its draft intact.
Step bodies and scripts are read-only while the editor is busy.
If the default disappears before confirmation, the tenant configuration is
preserved. Tenant-only flows and variables can be deleted using Delete.
Folder drafts belong to the selected tenant and session. After the server
confirms a folder was created, Update list retries loading the tree if needed.

Studio routes use `/v1/studio/<tenantId>/api/*`; navigation uses `tenantId`.

The reserved platform workspace is tenant `0`. Only platform administrators can
open it. Its detail page is read-only and links to the platform users list.
Other workspaces require an active tenant and authorized membership or
platform administration. Custom access policies remain tenant-scoped. Global
`platform` administration is a privilege scope, not a separate data workspace.

The tenant settings editor enables saving when the name or active status has
changed. Surrounding whitespace in the name does not count as a change.
The editor sends only the changed fields, preserving changes made elsewhere
to fields left untouched in the form.
The API confirms the save before the editor returns to the list. If the save
fails, the editor keeps the draft. If Savia cannot confirm the result, open the
tenant in another tab to check the saved settings before retrying.

Platform administrators can permanently delete a commercial tenant from its
edit page. The action requires typing the tenant's exact current name and
deletes its associated data. The UI sends
`DELETE /v1/tenants/{id}?cascade=true&confirmation=<exact tenant name>` only
after that confirmation. If the API rejects the name confirmation, the dialog
clears it and waits for the current tenant details before accepting a new
confirmation. The ordinary tenant delete endpoint remains available to API
clients.
The API rechecks the confirmed name as part of deactivation. If the name
changed before that point, the tenant stays in its current state and external
cleanup does not begin.
After deactivation, the API inventories data and files, including branding,
and rechecks the confirmed name before beginning external cleanup. A change
during inventory requires a new confirmation and leaves those files intact.
The API also rechecks the name after cleaning up Savia Request and Auth
settings, before removing files. When a change is detected at this stage,
completed external steps stay applied and the administrator must confirm the
current name to continue.
The final database batch verifies confirmation again. If the tenant changed
during file cleanup, the batch leaves its database records intact and asks
for fresh confirmation. Files already removed from storage stay removed.
If an external cleanup step fails, the API reports the failure and leaves the
tenant inactive so an administrator can retry the cleanup. Shared identity
principals are preserved. Core database cleanup runs as a batch; external file
and service cleanup can be partial when a remote service fails.
File inventory includes Companion recordings. The purge preserves any file
that another tenant or a shared database record still references.
If file inventory or deletion fails, the API returns
`TENANT_FILE_CLEANUP_UNAVAILABLE`. The dialog identifies the failed file
cleanup and refreshes the tenant so the administrator can retry.
An incomplete Companion file listing halts the operation before external
cleanup begins.
If Auth cannot remove its tenant settings, the API returns
`TENANT_AUTH_CLEANUP_UNAVAILABLE` and stops before deleting files. The
administrator can retry the deletion after Auth recovers.
An in-progress branding image upload blocks deletion before cleanup starts.
The confirmation dialog identifies the upload so the administrator knows when
to retry.
The full deletion can take up to two minutes before the browser stops waiting.
The confirmation dialog keeps the failure message visible. If the connection
drops or the result is otherwise unknown, refresh the tenant list to verify its
state before retrying.

The tenant and user lists remove deleted rows when they receive a realtime
event. Paginated results fetch fresh rows and totals, including when a
deletion shifts rows from another page. Tenant names with numeric suffixes
sort in numeric order, so `Demo 2` appears before `Demo 10`.

The users list resolves tenant names through the authorized tenant data provider.
Its scope heading and access column show the tenant name, never an internal ID.
If the name is unavailable, the heading stays generic and the access cell uses
an empty-value marker; platform and no-access badges keep their existing meaning.

When editing a user who already belongs to a tenant, select the destination
explicitly if the current tenant is absent from the available choices.
When removing platform administration, select an active commercial tenant and
the user's new role before saving. This also applies when there is only one
active commercial tenant. When creating a user or removing platform access,
search by tenant name or URL identifier to find choices beyond the first page.
The same search is available when transferring an existing user. Transfer
destinations are active commercial tenants. If the transfer fails, the
selected tenant and role stay in the form with an error message.
The transfer endpoint and the user update endpoint validate the destination
before updating the account in Auth. They check it again when writing the
membership.
If a combined profile and membership update is rejected while saving
access, Savia restores the previous profile and tenant settings in Auth.
It saves the principal's display name only after the access change succeeds.
When a user update supplies only a first name or surname, the API preserves
the omitted part of the current display name.
Successful transfers publish an access-control update to both the source and
destination tenants so authorized subscribers can refresh membership data.
The tenant administrator's users list uses these scoped updates to refresh
its rows and active-user count. Suspending, reactivating, or deleting a user
also publishes a scoped update to the user's tenant.
Profile and email-verification changes publish updates to the user's tenant
and the platform list, including changes made by a tenant administrator.
Tenant administrators also receive those updates in the user detail and
editor. The editor preserves unsaved changes and offers to reload the record.
Events for other users do not interrupt the current edit.
Switching records clears the previous record's notice and any queued refresh.
If the reload fails temporarily, the editor keeps the draft and the reload
action. A successful reload discards the draft if the editor stayed untouched
while it loaded. Edits made during the reload are preserved.
The reload button pauses while the editor is saving or a reload is in progress.
The user editor waits for the server to confirm changes. A rejected change
keeps the editor open with its selections and shows the error there.
Saving identity details only sends a platform access change if the platform
administrator toggle was changed. Tenant transfers use the assigned-tenant tab.
An access or verification change preserves the current name when the name
fields are untouched. Saving requires a change to an editable field.
Changing only the first name or surname sends just that field.
Existing accounts with a missing name or surname can be edited without
filling in the missing part. New accounts still require both fields.
The API trims surrounding spaces from supplied names and rejects names
consisting only of whitespace.

Tenant administrators can manage users assigned to their own tenant. The user
creation form fixes the new user's tenant to that administrator's tenant and
does not expose platform-administrator access or cross-tenant assignment.
Platform administrators can choose among multiple authorized tenants and set an
optional active user limit for an authorized commercial tenant. The user-capacity view reports
the number of active users, including tenant administrators; a blank limit is
unlimited. The API enforces the limit when creating or reactivating users, so a
client-side count never grants permission to exceed it.

When creating a user, you can assign up to 100 enabled custom roles from the
destination tenant in addition to the base role. A refresh that confirms a
selected custom role was disabled or removed clears that role and shows a
notice. Other selected roles stay in the form. The limit applies to each
user's assignments. The role catalog can list more than 100 custom roles.
When a selection reaches the limit, remove a selected role to choose another.

The data-domain catalog, creation operation, runtime routes, and `domain:<slug>`
ACL scopes have been removed. Create workspaces through tenant management.
Business-domain modules (for example the `/v1/domains` capability catalog), DNS
domains, and compatibility identifiers for external agency integrations are
unrelated to data isolation.

## Migrating existing installations

SQLite/D1 migration `0077_tenant_only_isolation.sql` and PostgreSQL migration
`0018_tenant_only_isolation.sql` convert existing workspace storage:

- `domain:platform` becomes `tenant:0`.
- `agency:<id>` becomes `tenant:<id>` without changing the numeric tenant.
- Each custom domain becomes a distinct tenant with a generated numeric ID.
- `tenant_namespace_migrations` records the old key and destination tenant as
  migration provenance. The runtime never uses it to resolve a workspace.

Apply the migration as one transaction. The native SQLite/PostgreSQL runners
already wrap migrations transactionally. The D1 REST migration runner submits
this migration and its ledger entry as one batch of separate query objects,
which preserves trigger bodies and makes failure atomic. See the
[Cloudflare D1 batch request contract](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).
Do not manually execute the namespace conversion one statement at a time.

Preflight checks reject namespace collisions, unmapped old storage keys, and
custom-domain grants incompatible with a user's tenant membership. Legacy
platform-workspace grants to non-administrators also require explicit resolution. Resolve the
reported condition before retrying. Do not delete records or grants merely to
make the checks pass. When an existing tenant is the intended destination, an
operator can prepare an explicit `old_key`/`tenant_id` mapping in
`tenant_namespace_migrations` before running the migration; the same collision
and membership checks still apply. Back up the database and retain its matching
R2 bucket before a deployment migration.

Stored file keys are opaque references. The migration changes ownership columns
while retaining those keys, so existing R2 objects and file revisions stay
readable without renaming blobs. Authorization uses the canonical tenant row.

The admin **Keys and services → Services** tab separates platform credentials
from workspace credentials. Platform credentials are mounted and requested only
after platform-administrator permissions are confirmed; tenant administrators
see workspace services without a platform access-denied banner. Geoapify keeps
its tenant-scoped override: a saved workspace key takes precedence over
`GEOAPIFY_API_KEY`, and removing the override restores the server fallback.
Assistant configuration and its tenant overrides remain platform-admin-only.

Encrypted integration, collection-source, geocoding, webhook, and extension credentials
retain their original authenticated encryption context in a versioned ciphertext
envelope. Readers require the canonical expected context and decrypt using the
original AAD. Saving a replacement credential encrypts directly under the new
context. Migration code does not decrypt or log secrets.

PostgreSQL migration `0019_tenant_identity_projection.sql` also brings the native
identity-table projection into line with the existing SQLite tenant tables and
compatibility views. Historical migration files and checksums are preserved.

Self-hosted installations keep Request data in a separate store. Its forward
SQLite migration `0007_tenant_only_isolation.sql` and PostgreSQL migration
`0005_tenant_only_isolation.sql` convert request overlays, variables, history,
bundles, and audit ownership. During startup migration, self-hosted copies the
core migration map into that store first; conflicting maps stop initialization.
For a standalone Request database, prepare custom-domain mappings from the core
store before applying the migration. Unknown custom domains fail rather than
receiving a guessed tenant ID. The empty Request scope remains the shared
package catalog, not a tenant workspace.

Native PostgreSQL authentication also uses PostgreSQL notice triggers, allowing
email-verification and two-factor events to work during local startup checks.

Admin refresh sessions are bound server-side to the exact origin that initiated
the login. Canonical and tenant origins remain separate session origins, including
for platform administrators. The OAuth callback may pass through the canonical
origin, but returns the session to its recorded initiating origin. Trying to
renew a session from a different host is rejected and requires an explicit login
from that host. Existing admin sessions must log in once after this change is
deployed; this does not imply that the external identity provider will always
prompt for credentials again.

A tab requesting renewal from another origin receives 401 and must sign in
again. It does not revoke a valid session belonging to that other origin or
clear shared cookies: an older tab must not sign out a newly authenticated tab.
Missing or expired origin bindings still trigger session cleanup.

Each HTTPS origin has its own HttpOnly admin refresh cookie name. The canonical
callback writes the cookie for the origin recorded in the OAuth transaction,
using the shared canonical cookie domain so that the tenant can receive it.
Signing in or signing out on another origin does not replace or clear that
origin's refresh cookie. Existing unsuffixed cookies remain readable until they
rotate to the origin-specific name; server-side origin validation still applies.
The origin-specific cookie takes precedence over an older unsuffixed host-only
cookie. When the API uses a different origin, cookie selection uses the
validated caller origin from the `Origin` header, falling back to the request
URL for same-origin requests without that header. Browsers can send both a host-only and parent-domain cookie with the
same name; accepting the first unsuffixed value can otherwise reject a fresh
login and clear its session even when only one tenant is used.

## Local checks

Run `node --test scripts/tenant-only-migration.test.mjs` for populated SQLite
fixtures, collision rollback, permission conflicts, credentials, and widgets.
Run the API/admin suites for workspace selection, forms, permissions and routes.

For PostgreSQL, use a dedicated test server with database creation rights and set
`SAVIA_TEST_POSTGRES_URL`; then run the self-hosted
`tenant-isolation-migration.test.ts` and `postgres-migrations.test.ts` files.
These tests create and remove isolated databases. Never point them at a shared
production server.

Logout validates its caller origin and checks the stored binding before revoking
an admin refresh session. An unsuffixed cookie belonging to another origin does
not revoke that origin's bridge or provider session or clear its shared cookies.
