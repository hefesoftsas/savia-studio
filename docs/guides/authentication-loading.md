# Authentication loading

The application boot splash, login redirect, OAuth callback and OAuth form
submission share the logo, ring animation, dimensions, colors and message
defined in `packages/tenant-host/src/loading.ts`. The admin's `PwaSplash` renders
the same presentation used by the authentication worker's server-rendered
loading state. The static first-paint splash in `apps/admin/index.html` mirrors
this appearance. If the OAuth callback fails, the admin keeps its error message
and return-home action.

OAuth keeps its form mounted while a request is pending. It shows the loading
state until navigation begins, or restores the form when credentials fail,
second-factor input is needed, or MFA enrollment requires another step. Existing
tenant branding and the decorative login animation remain on the form. The
loading indicator exposes an accessible status and respects reduced motion.

Opening the authentication worker's login page directly can omit the signed
OAuth request. After successful authentication (including any second factor),
the page returns to the configured admin login route to start a fresh
authorization. The same recovery applies after social or SSO authentication.
It does not call the OAuth continuation endpoint without a signed request;
normal signed requests keep their original continuation and destination.

The API forwards the optional signed `oauth_query` on password sign-in, TOTP
verification and recovery-code verification. Better Auth validates this context
and uses it when creating the session to complete the requested authorization.
Dropping the query at the API boundary leaves `prompt=login` pending: a valid
second factor then returns to login instead of the application's callback.

If a second-factor challenge expires or exhausts its permitted attempts, the
login page starts a fresh authorization through the configured admin login
route, preserving the tenant host. MFA challenges expire after five minutes
and are single-use. An incorrect authenticator code keeps the form available
while the challenge still permits another attempt. Account lockout messages
remain visible. Both authenticator and recovery-code sign-in use this recovery
path. The client reads Better Auth's `code` field as well as OAuth's `error` field
to identify a challenge that needs to be restarted.
If the authenticator or its recovery-code configuration is removed while an
MFA form is open, the form restarts sign-in and keeps the requested destination.
If the session expires before MFA setup can generate the authenticator code,
the setup form starts a fresh sign-in through that same Admin route.
An incorrect password keeps the active setup form available for correction.
If the response lacks the authenticator setup URI, the form remains available
for retry. When the setup details appear, focus moves to the verification code.

The shared loading style is delivered through the existing authentication CSS
route; it does not require a new script or animation library. It represents
pending work and does not add a minimum display time or delay navigation.

Admin API requests preserve the HTTP status when an error response has
an empty, invalid, interrupted, or stalled JSON body. If the server already sent a
`Retry-After` deadline with HTTP 429, the client preserves it even when the
response body times out.
Admin queries handle HTTP 401 and 403 on the first failure and clear any
protected data they previously cached. HTTP 429 is also reported on the first
failure so the client does not automatically repeat a rate-limited request.
The client also reads JSON media types such as JSON:API and uses the problem
detail or title when an error arrives as `application/problem+json`.
Successful no-content responses are accepted even if they declare a JSON media type.
The JSON client rejects an HTML page returned by an API route, even if its
HTTP status indicates success. Callers that need HTML use the raw response API.
For JSON writes, the client preserves caller-supplied request headers, including
an explicit content type, and adds authentication headers to a copy.
Admin API requests allow up to 15 seconds to obtain an access token, then start
the request's separate deadline. The standard request deadline is 15 seconds
and covers the body for JSON and OAuth session requests. Requests that callers
cancel before they start never reach the network. Cancelling a request in
progress preserves the caller's cancellation reason. Reaching the deadline
reports a timeout even if the transport returns its own abort error. Page-file
uploads and companion recording uploads allow five minutes for larger files and
slower connections. If the application splash or a route fallback remains
visible for 15 seconds, it replaces the spinner or skeleton with
actions to retry or return to sign-in. The users list also shows a retry action
when its data request fails, including when it reaches the request deadline.

The OAuth sign-in and second-factor forms restore the failed form after 15
seconds if the authentication request stalls, including while reading its
response. The form recovers even when the transport ignores cancellation.
The form discards late responses and lets the user explicitly retry.
The pinned OAuth provider decodes URL-encoded exchanges from their original
UTF-8 bytes in Workers. The parser still validates repeated client fields and
preserves the ordered list of resource values.
The SSO connection lookup has the same deadline and restores its form on timeout.
Editing the SSO email or starting another lookup clears the previous connection
choices. Only results for the current email are offered.
Choosing one of several SSO connections blocks additional selections while
the sign-in request is pending. If it fails, the choices become available again.
When sign-in requires a second factor, keyboard focus moves to the
authenticator code after its form appears, including after returning from SSO.
After a failed code verification, focus returns to the current code field
so the user can correct it and retry.
If the second factor succeeds and OAuth continuation fails, **Continue to
Savia** retries only the continuation. If the verified session has ended, the
login page starts a fresh authorization.
After social sign-in or SSO, **Continue to Savia** also retries a failed
continuation with the original signed request. If the SSO session has ended,
the login page restarts authorization for the original destination.
Tenant discovery on the sign-in email field only remembers confirmed results.
A dedicated workspace redirect requires a configured tenant domain. Sign-in
on the local development host or an isolated branch Preview continues on the
current origin.
A later blur can try again after an unconfirmed or timed-out lookup.
If tenant navigation stalls, the same email can trigger a new lookup while the
manual continuation link remains available until the next navigation begins.
Submitting the sign-in form or choosing a social provider cancels any pending
tenant redirect. A late lookup cannot interrupt the sign-in attempt or replace
its response.
If the browser does not finish navigating to a social provider, the page
restores the sign-in controls along with the manual continuation link.

The Admin OAuth bridge waits up to four seconds for the authentication client
metadata and up to ten seconds for authorization, code exchange, or session
renewal, including reading the provider response.
It returns an uncached service-unavailable response when it cannot start
authorization.

Clearing the browser session cancels pending OAuth token exchanges and renewals.
Responses from those requests cannot restore the old session after sign-out.
An avatar request can only update the cache while it remains current, so an
older response cannot overwrite the profile photo after a profile refresh.
An invalidated identity request cannot replace the current principal or clear a
newer identity result, even if the previous request fails.
A permission lookup still in progress at sign-out returns signed-out permissions
and cannot repopulate the session's offline cache.
Explicit logout waits for the server sign-out and workspace cleanup before
clearing mounted queries and redirecting to authorization. Clearing auth queries
while asynchronous cleanup is still pending can trigger another authentication
check and repeated logout, leaving the current tab blank. Query cleanup still
runs if workspace cleanup fails.

Logout still rotates the session read generation to invalidate protected reads,
but only principal replacement changes the application subtree key. Keep React
Admin mounted during logout so its active logout hook can finish cleanup and
redirect. Office availability starts after the authenticated layout mounts.
Clearing the session discards pending results and stops Office availability
requests while logout finishes.

If the browser does not finish an OAuth redirect within ten seconds, the page
restores its content and exposes **Continue to Savia** as a normal link to the
same server-provided destination. It preserves the authorization, PKCE and MFA
requirements; the link does not create a different session or grant.

Profile refresh and background route reads do not re-enter the application boot
splash. Actual principal replacement rotates the authenticated subtree and
discards previous-owner state. Dedicated tenant lookup has a separate boundary:
its initial failure offers retry and prevents protected default-scope reads while
keeping sign-in available. See [stable background refresh](background-refresh.md)
for read retention and authorization-denial rules.

Explicit sign-out immediately shows a branded “Signing out…” transition and
makes the workspace inert while server sign-out and cleanup finish. The workspace
stays mounted so pending auth work can complete. The transition adds no artificial
delay, respects reduced motion, and releases its busy state if sign-out fails.
Automatic access failures do not display this explicit sign-out transition.

On a callback URL containing an OAuth code and state, early access-token reads
join the single callback exchange before attempting renewal. A background read
must not start a refresh against the canonical callback origin while a tenant
login is being exchanged. The session still returns to the initiating tenant.

When a same-origin or recognized public-origin refresh request has no renewal
cookie, the API returns 401 without looking up OAuth client metadata from the
auth worker. Other cross-origin clients retain configured-client CORS validation.
This avoids a provider initialization delay before an inevitable login redirect.

The auth worker reports `auth_schema`, `auth_bootstrap` and `auth_dispatch`
durations in its `Server-Timing` response header. Compare those phases with the
request's total time before attributing a delay to schema or bootstrap work; a
slow response alone does not identify which phase is responsible.

Successful API `GET /api/auth/admin/authorize` redirects report `oauth_client`
(admin OAuth client metadata lookup), `oauth_transaction` (PKCE transaction
creation and persistence), and `oauth_authorize` (the authorization redirect
service call) in `Server-Timing`. These values are durations only; the header
does not include request URLs, state, tokens, or cookies.

Protected API requests without an `Authorization` header or any `Cookie` are
rejected before the API calls the internal session service. Requests with
cookies still validate their session with the auth worker.

## Deployment preparation

Managed preview and production releases prepare Auth before opening application
traffic. The frozen Auth configuration includes `SAVIA_AUTH_DEPLOYMENT_REVISION`,
set to the exact source commit. After publishing Auth, the managed publisher runs
`scripts/initialize-auth-deployment.mjs` through a short-lived authenticated service
binding. The initialization endpoint requires the internal bridge credential and
an exact revision match. Credentials are never written into the probe configuration
or command arguments.

Preparation performs schema migrations, bootstrap client reconciliation and OAuth
resource seeding, then records readiness in Auth D1. Readiness includes the revision,
a SHA-256 configuration fingerprint and public client metadata. Normal managed
requests load this record once per handler and do not rerun migrations or bootstrap
writes. `auth_readiness` measures this lookup; managed requests omit
`auth_schema` and `auth_bootstrap` because those phases ran at deployment. Missing or mismatched readiness returns 503 instead of preparing Auth during
login. A failed preparation blocks API publication and uses the existing release
recovery path. Previous readiness records remain available for rollback. Local and
branch environments without the managed revision retain lazy initialization.

Preparation also completes Better Auth's explicit schema validation before
recording readiness. Managed request handlers disable its automatic background
schema check. A short metadata request must not start request-owned introspection
that later authentication requests would await after the first request has ended.
Runtime handlers rely on the validated readiness record; deployment and local
initialization retain schema validation.

The backup write barrier exempts conservative, single-statement `SELECT` reads.
Previously, even tenant and login-policy reads acquired and released durable
write permits, adding two coordinator calls per query. Writes, ambiguous SQL,
batches, and `exec` still acquire permits; `UPDATE ... RETURNING` remains guarded
even when executed through a read-shaped method such as `first()`. Policy reads
remain current on every request and are not replaced with a cross-request cache.
The gate client also cancels unused response bodies after successful permit
release and before retrying failed coordinator responses. This prevents
unneeded internal response streams from accumulating. It is a resource-lifecycle
hardening change; current live evidence does not establish it as the cause of
the reported pending Auth requests.

The API login proxy also reports tenant-context lookup, registration preflight and
the final Auth round-trip in `Server-Timing`, alongside Auth's own phases. Tenant
resolution is reused within the request; branding, tenant validation and registration
availability keep their existing checks. Use these measurements to distinguish
remaining database/network time from deployment preparation.

The public login context resolves the tenant and its optional branding in one
database query, preserving canonical-slug priority, aliases and active commercial
tenant filtering. Registration preflight and the Auth login page run independent
settings, email availability and password-policy reads concurrently, and internal
OAuth client metadata endpoints (`/_internal/oauth/admin-client` and
`/_internal/oauth/scalar-client`) return directly from the readiness bootstrap
before awaiting the Better Auth database adapter. These reads remain scoped to
the request, so policy changes do not wait for a cross-request cache to expire.

A temporary OAuth renewal failure (timeout, network error, rate limit, provider
server error or malformed token response) returns `503 AUTHENTICATION_UNAVAILABLE`
and preserves the renewal cookie and origin record. A later retry can reuse that
session. Only a confirmed `invalid_grant` or `invalid_token` from the provider
clears renewal state and returns 401. The browser stops trying to renew only
when it receives HTTP 401. A rate-limit response from the edge remains
retryable. When an unmated or expired refresh cookie
triggers session cleanup, the API reuses the single `admin_oauth_session_origins`
lookup instead of issuing a redundant `DELETE` write when no row exists, and
cancels unconsumed internal Auth service response streams. Deployment
unavailability must not sign users out permanently.
