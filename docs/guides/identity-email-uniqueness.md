# Identity email uniqueness

Savia prevents a new active principal from using another active principal's email. The comparison trims surrounding spaces and ignores case. The rule spans authentication issuers: a matching email alone never links accounts or transfers roles.

The identity repository checks before an authentication principal is created or changes email. User provisioning checks before creating the Better Auth account or sending a password setup message. A conflict returns HTTP 409 with code `IDENTITY_EMAIL_CONFLICT`; administrators must resolve the conflicting identity explicitly. Successful repeat logins with the same issuer and subject retain the principal ID and assignments. If the normalized email and display name are unchanged, the login does not rewrite the principal's `updated_at`; changed profile data is persisted. An inactive principal is not automatically reactivated by login.

Tenant creation with `initialUser` provisions a new authentication account. If
the email already exists in Better Auth, the private provisioning bridge returns
the same HTTP 409 conflict instead of throwing an unhandled service error. The
API preserves that conflict and rolls back the new tenant. The existing account
and its membership remain unchanged. If provisioning fails after Auth creates
a new account, the API attempts to remove that account even if cleanup of the
tenant database fails. To create a tenant around an existing
account, a platform administrator must explicitly use `existingMember`; that
operation transfers the user's membership and applies its usual tenant rules.
The form explains when the selected user is unavailable, is a platform
administrator, or is the last active member of their current organization.
The latter two cases return `TENANT_CONFLICT` with a specific reason.
The API checks for a last active member before reserving the new tenant's URL
or updating Auth and rechecks membership when applying the transfer.
A tenant created as inactive can have a first administrator assigned during
creation. The tenant remains inaccessible to its members until activation.
If the transfer fails, the API removes the provisional tenant and releases its
URL even if the Auth service fails to restore the user's previous email scope.
In that case the API returns the Auth rollback error.
The existing-user selector shows each account's name and email, including the
selected account, so administrators can distinguish identical display names.
Search accepts either name or email.

Tenant creation with an existing administrator, tenant assignment, and changes
to platform access share a per-user lease across the Auth update, the local
membership write, and any rollback. Simultaneous access changes for the same
user return `IDENTITY_ACCESS_CHANGE_IN_PROGRESS` and can be retried after the
ongoing operation finishes. Apply `0076_identity_access_change_leases.sql` in
the core database before publishing the API.
Tenant cascade deletion checks these leases before deactivating the tenant or
starting cleanup. Access changes verify that the source tenant is available
after they acquire the per-user lease. A conflicting request returns
`TENANT_PURGE_IN_PROGRESS` before changing Auth or deleting data.

SQLite migration `0078_identity_principal_email_uniqueness.sql` and PostgreSQL migration `0020_identity_principal_email_uniqueness.sql` add database guards for inserts, changes to an active email and reactivation. Database enforcement covers concurrent requests as well as application checks. Deploy the migration with the API change.

The migrations deliberately leave historical duplicate principals intact. Their existing same-subject logins and profile updates continue to work; no privileges, memberships or audit references are merged or deleted. Resolve those duplicates only after checking the authoritative authentication account and each principal's assignments. A display name or email is not enough evidence to delete an identity.

Regression coverage: `apps/api/test/identity.test.ts` and `scripts/identity-email-uniqueness.test.mjs`.

Tenant administrators can list, provision, view, update, suspend, reactivate,
reset passwords, revoke sessions, and delete users only within their active
tenant. They cannot create platform administrators or move a user to another
tenant. Platform administrators retain cross-tenant identity management. User
capacity is configured and enforced as described in the
[tenant user capacity guide](tenant-user-capacity.md).

The API-to-Auth user administration bridge uses a purpose-derived key generated
from the configured `SAVIA_MCP_SHARED_SECRET`; provisioning scripts store the
derived value for Auth and API. Auth rejects requests to its private user
administration endpoints without that key. Public Better Auth administrator
permissions are unchanged.
