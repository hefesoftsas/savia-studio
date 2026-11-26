# Public forms

Owner: Savia platform team. Last reviewed: 2026-09-29.

## Publishing

Forms remain private until a platform or tenant administrator opens a screen's configuration,
navigates to the dedicated **Enlace público** page, confirms the published snapshot,
and creates a link. The administrator can set an expiration (with quick presets for 24h,
7d, 30d, or no expiration) and a daily submission budget. Administrators may
optionally attach a logo (PNG, JPEG, or WebP up to 2 MB, downscaled to 512px):
it is frozen with the published snapshot and shown at the top of the public
form for both record and quote links. Publishing creates the canonical
URL and requests a short URL in the same action. Each URL has its own copy icon; the
remaining link actions use labeled icon controls with tooltips. If shortening fails,
the canonical URL remains available and an icon retries the short URL. Administrators can
share via the native Web Share API
on mobile devices, open the form in a new tab to test it, and revoke each link independently.
Revoked or expired links can be permanently deleted with their submission history; active links
must be revoked first so in-flight deduplication is never dropped silently. Each active link can also
show a QR code encoding the same canonical URL, with SVG and PNG download for
print or in-person sharing. The default budget is
25 submissions per link per UTC day. Existing links do not inherit later edits;
review and publish a new link after changing a form. Revoke the previous link when
replacing it.

Read-only quote result links use the same public-link lifecycle primitives as
forms and shared Pages: 256-bit random bearer tokens, canonical expiry checks,
no-store/noindex responses, and idempotent revocation. They remain a separate
link type because their payload is an immutable allowlisted quote report, not a
form definition or permission to submit another quote. WhatsApp-created reports
expire after seven days and can be revoked by an active tenant administrator
from the quote link manager; opening one never starts provider or model work.

Savia keeps an internal random short code as a fallback. When Shlink is configured,
it also creates a short URL on the self-hosted `go.cloud.hefesoft.com` domain and
caches it with the published form. Until an external URL is saved, the stored
internal short URL remains visible in the management list, including after a
reload during a provider outage. The same short URL is returned when an
administrator requests it again. Redirects stop working when the form is revoked,
expires, or is deleted; links are rate-limited.

Native collections support plain text, numeric, email, date, boolean, and static
select fields. Hidden, read-only, computed, secret, relational, remote-option,
file, and scripted fields are not exposed. Unsupported required fields block
publication. Collection-bound screens cannot accept public submissions. A native
submission creates a CRM record; it never executes request-page scripts, lookups,
or arbitrary plugin actions. Existing CRM validation also applies at submission.

Quote screens contributed by a plugin can support a dedicated public form. Open the quote screen, select **Configurar**, review the enabled products, and
click **Guardar cambios** at least once before publishing. A newly installed plugin
can render its default products without having a saved configuration. Publishing
requires a saved settings version and an enabled quote screen; otherwise the API
returns HTTP 409. The management page explains this prerequisite instead of
reporting a connection failure. The server freezes the allowed products
and checks the installed extension and settings version on use. For a ZIP-installed
quote plugin, the version comes from the tenant's enabled installation rather
than the latest ZIP upload or compiled extension registry. Changing that
configuration requires republishing. Visitors cannot choose connections, actions,
execution mode, or provider flows. They enter vehicle and applicant information
manually; private vehicle lookup endpoints remain protected.
If the plate lookup takes more than ten seconds, the wizard unlocks the vehicle
fields for manual entry and offers another lookup without clearing the plate.
Repeated lookups refresh autofilled values and preserve manual edits. Changing
the plate clears values still marked as autofilled, even after a partial result.
Vehicle currency fields accept whole amounts with optional thousands grouping.
Invalid signs and fractional values remain visible for correction.

Quote links for `cotizador_por_pasos` render the public plugin wizard with the
published product snapshot and three steps: vehicle, applicant and driver, and
contact and quote. Age uses the entered calendar date and the visitor's local
day. The quick age presets choose a birth year that matches the selected age.
Pressing Enter in a form field validates and advances the current step. The
quote is submitted only from the final step after verification.
The public experience omits authenticated history, CRM
records, provider configuration, and admin navigation; the private vehicle
lookup endpoints stay protected and only the safe projection above is public.
Changing quote settings or enabled products still invalidates the frozen
snapshot and requires publishing a new link.

The public wizard preloads vehicle data from the plate through
`POST /api/public/forms/:token/vehicle-lookup`, mirroring the embedded plate
lookup: typing the plate and pressing the search button (or leaving the field
with at least 3 characters) fills the Reference code, production year, and
declared values, marking them
as autocompleted. A malformed plate names the exact field instead of calling
the lookup. The server runs the fixed plate-lookup
flow from the current trusted settings — visitors can never select actions,
connections, or flows — and returns only the plate plus those fixed vehicle
fields; raw provider output stays hidden. The lookup needs no CAPTCHA because
it happens before the final verification step, so it is bounded by the burst
rate limiter and strict plate format instead of submission quotas.
The public quote and plate-lookup flows call the bound Savia Request service
directly through the configured request adapter. The implementation is installed
through the ZIP package.

City fields offer DANE autocomplete through
`GET /api/public/forms/:token/cities?search=`, scoped to the same quote link.
Only the latest search can update the suggestions, and timed-out searches
leave the city code editable.
Leaving the city control cancels the search. Choosing a suggestion returns
focus to the city field.
The arrow keys highlight a suggestion, Enter selects the highlighted result
(or the first when none is highlighted), and the clear button resets the
field. DANE codes are public reference data, so the endpoint returns a bounded list
of code/city/department triples with no upstream internals and no provider
cost. Applicant identity fields stay manual: looking up CRM records by
document number would disclose personal data to anyone typing an ID, so that
capability remains authenticated-only.

By default the response is only an acknowledgement and submission reference.
For quotation links, administrators may explicitly enable a limited result for the
current submission: provider/product labels, premium, currency and supported coverage
labels. Coverage bullets come from the live provider breakdown when present;
otherwise they fall back to the frozen plan catalog so each card still
describes its policy (never quote numbers, raw responses, or customer data).
The public results list shows the provider and product, alongside the quoted
amount in COP or the current status. Visitors can print the reference and
results to PDF from the browser. Print output hides the language selector,
cookie notice and action buttons. An invalid quote row is counted as
unavailable and leaves the other results visible. While providers respond, the wizard shows
elapsed time and any progress it receives from the anonymous per-submission
status endpoint, checking about every five seconds while the tab is visible
and the submission is pending. Links configured for acknowledgement only keep prices out
of both the receipt and progress responses. Raw provider responses, credentials
and customer identifiers are never returned. A single submission can call
each enabled provider once, so its cost
scales with the number of enabled products. Provider calls run with bounded
concurrency (10 at a time) so the visitor wait stays flat as products grow. Daily budgets count submissions, not
provider calls; start with a small budget for public quotations.

## Deployment configuration

1. Apply D1 migrations `0064_public_form_short_links.sql`,
   `0065_public_form_external_short_url.sql` and `0076_public_form_logo.sql`
   (plus native PostgreSQL migration `0017_public_form_logo.sql` for
   self-hosted installs) using the normal migration pipeline.
   Active public forms receive an external short URL automatically when the
   provider succeeds; the full link remains available if it is unavailable.
   The provider receives the complete public URL, including its bearer token.
2. Create a Cloudflare Turnstile widget for the canonical public hostname.
3. Configure `TURNSTILE_SITE_KEY` and secret `TURNSTILE_SECRET_KEY` on the API worker.
   Keep the secret outside source control and frontend environment variables.
4. Set `SHLINK_SERVER_URL` to `https://go.cloud.hefesoft.com` and store
   `SHLINK_API_KEY` as an API Worker secret. The key stays server-side. If either
   setting is missing, the canonical URL and Savia-hosted fallback remain usable.
5. Set `SAVIA_PUBLIC_ORIGIN` to the canonical HTTPS origin serving the admin gateway
   and public pages. Links always use this origin, even when created from an agency
   subdomain. Configure preview and production independently.
6. Deploy API and admin together. The production configuration generator includes
   the `PUBLIC_FORMS_RATE_LIMITER` binding (30 requests per minute per IP).

Missing configuration fails closed. Public-host deployments reject Turnstile test
keys; fake Siteverify responses are injected only by tests. Captcha validation uses
Cloudflare's server-side verification, checks hostname, `public_submit` action and
link identifier, and has a timeout. Browser-only captcha validation is insufficient.
If verification fails to load or complete on a public form or quote wizard,
**Retry verification** reloads the challenge and preserves the entered values.
A new submission or a language change starts verification without showing the
previous challenge's error.

## Local development

The local stack (`pnpm dev`) sets `SAVIA_DISABLE_CAPTCHA=1`, which skips
anonymous verification so links can be published and submitted without Turnstile
credentials. The bypass is honored only when `SAVIA_PUBLIC_ORIGIN` is a localhost
origin; with any other origin the flag is ignored and the normal provider
configuration applies. Preview and production therefore always fail closed when
unconfigured. The public page reports `captchaProvider: "disabled"`, mounts no
widget, and submits immediately. The admin Vite server proxies local `/s/` short
links to the API so they resolve to the same public form as the canonical link.
Distinct local submissions can share the development verification value and
remain individually retryable. With verification enabled, a consumed challenge
requires a fresh challenge for a new submission.
Never set `SAVIA_DISABLE_CAPTCHA` outside local
development.

For the same reason, `pnpm dev` sets `SAVIA_MOCK_QUOTES=1` (override with
`SAVIA_MOCK_QUOTES=0`): quote execution and plate lookup return fixed
simulation data instead of calling providers, so the whole public flow can be
exercised without credentials. Availability, policy, and validation checks
still run; only provider I/O is faked, and the fixture is constant on purpose
so it can never pass as a real provider response. Never set
`SAVIA_MOCK_QUOTES` outside local development.

## Security and reliability boundary

The public page waits up to 15 seconds for the form definition, including the
response body. Visitors can retry loading the same link after a connection or
service failure. An expired or revoked link prompts them to request a new one.

The public page loads independently of the administrative app: no session bootstrap,
workspace replica, IndexedDB initialization, or administrative synchronization.
Public requests omit credentials. The gateway serves the public page as an asset
route and forwards public API requests to the API worker. API reference documentation
is generated from the route schemas and available in Scalar.

When external shortening is enabled, the Shlink server receives and stores the
canonical URL, including the public form's bearer token. It receives no applicant
values or CRM records. Provider failures leave Savia's canonical and internal
fallback links usable.

The anonymous API only exposes the intentionally published field definition and
accepts submissions. It provides no collection listing, record lookup, history,
update, or delete capability. Management remains authenticated and restricted to
platform administrators or active tenant administrators (`tenant_admin`, including
its legacy `agency_admin` role) within their own active commercial tenant. Tenant
administrators cannot manage the platform workspace (`tenant:0`) or another
tenant's links. Creation and listing validate the requested tenant; shortening,
revocation, and deletion authorize against the link's stored tenant, regardless
of caller-supplied tenant parameters. Operators and viewers cannot manage links.
Public responses are not cached and are marked noindex.
The random link token cannot be used as an administrative credential.

Before any side effect, D1 atomically reserves the submission and enforces per-link,
per-IP (20/day), and per-tenant (1,000/day) quotas. Captcha reuse is blocked globally.
These persistent quotas complement the burst limiter. Failed or interrupted attempts
consume budget because provider calls may already have occurred. Request bodies are
limited to 32 KiB; only declared primitive field values are accepted.

Repeated submission identifiers never re-execute side effects. An exact replay with
the original captcha proof can return its saved acknowledgement; a changed proof or
incomplete attempt returns a conflict. Failed submissions keep their safe server
status (validation, provider, or policy messages) instead of a generic error;
only unexpected failures stay a sanitized 503 with no provider details. The browser retains the submission identifier
after an uncertain response and does not silently start a new request. Revocation
blocks new reservations; it cannot undo provider calls already started.
If a link is revoked or its workspace deactivated during verification, the
request is rejected as unavailable without consuming a submission slot.
An HTTP 408 also preserves the original submission identifier and values.
Once a daily limit is reached, the API returns the next UTC midnight in
`Retry-After`. The form shows the reset time in the visitor's browser time zone.
Replay conflicts are identified separately from other HTTP 409 responses. If
configuration changes invalidate a link, the form asks for a replacement link.

Submission reservations and acknowledgements are retained to preserve deduplication.
They contain hashes instead of raw IP addresses/captcha tokens, and no native form
values. Native values live in the protected CRM record. Quote execution inputs remain
in protected extension-run storage; results there use the same safe projection.
Every quote submission also mirrors one `cotizaciones` master plus one
`cotizaciones_detalle` per enabled product into the agency CRM (same fields as
the embedded wizard, never provider quote references), named by the public
reference so the agency can match it. The mirror is best-effort and idempotent
per submission: the visitor result never depends on it, and uncertain retries
replay the same rows.
Monitor D1 storage and provider usage as traffic grows. Do not delete reservations
for an active link without considering the loss of deduplication guarantees.

## Verification

API tests use real local D1 with fake captcha verification and fake quote executors.
They cover authorization, strict projection, captcha binding, expiry/revocation,
concurrent quota enforcement, durable idempotency, and request limits. Browser
component tests cover publication/revocation, QR toggle/download, captcha lifecycle, bounded result
rendering, and duplicate-click/network-retry behavior. No live provider calls or
customer forms are required for verification.

## Self-hosted Docker CAPTCHA

The native Docker runtime uses ALTCHA instead of requiring Turnstile credentials. Challenges are generated and verified locally, expire after five minutes, and are bound to the form, public origin and submission action. The receipt stores a canonical proof identity to prevent replay via alternate encodings. An uncertain retry keeps the exact original proof and submission ID so a saved receipt can be returned after expiry. The widget and its worker are bundled locally. The existing submission-only API, field validation, rate limits and quotas remain enforced. Cloudflare keeps Turnstile as its default. See the [Docker deployment guide](guides/self-hosted-docker.md).

### Public form brand layout

When a link supplies a logo, it replaces the standalone Savia heading. The logo
is grouped with the form title; quote forms center the logo, title, and product
count in one compact header. Images retain their original aspect ratio without
cropping. The Savia attribution remains in the footer.

### Completing public quote submissions

The status endpoint includes the committed public receipt once a submission is
complete. The client accepts that receipt even if the original POST is still
waiting, and stops the duplicate request. A bounded POST wait retains the same
submission identity for recovery. Status polling never executes provider flows.
The POST deadline covers both the connection and the response body.
A committed receipt is still available if the provider progress lookup fails.
A recorded failure ends the waiting state and directs the visitor to the form
owner before resubmission. The status response omits provider error details.
A late POST response cannot replace the receipt recovered from status.
After a lost submission response, the visible wizard checks the same
submission a bounded number of times while it waits for a receipt, including
after temporary failures in the status connection.
Each status check times out after five seconds so a stalled response cannot
prevent those recovery attempts.
The final screen keeps completed provider results and failures already exposed
by the public status endpoint when the receipt contains only a reference.
Pending progress is hidden on the final screen. Private record identifiers
and payloads remain unavailable. One outer progress indicator owns the waiting
state; the embedded comparator does not duplicate it.

### Quote history details

Public quote submissions save the same normalized coverage snapshot as the
internal quote wizard in `cotizaciones_detalle.resultado_snapshot`. The projection
is computed from the provider response before public fields are restricted; raw
payloads and provider quote identifiers are not exposed publicly. Older schemas
continue to save core results. Historical records without snapshots cannot regain
missing provider details by reloading. The public waiting state uses one progress
bar, without a duplicate circular busy indicator.

Public quote references use `COT-YYYYMMDD-HHmmss-XXXXXXXX`, with date and time in
America/Bogota and a submission-derived suffix. The receipt and CRM master use
the same reference; the UUID remains the internal idempotency and status identity.
Existing references are not renamed.

Quote comparisons use provider-defined facts and configured result columns. The
response details show the full normalized result alongside any warnings.
