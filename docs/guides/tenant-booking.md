# Tenant booking

Owner: Savia core · Reviewed: 2026-10-03

Booking is a native, optional tenant capability. It starts disabled and unpublished. It does not require a separate booking service. Professionals must be active Savia users with an active membership in the same commercial tenant; platform administrators are not eligible professionals.

## Set up and publish

When you open **Bookings** from the Savia platform, choose an organization to open **Bookings** in its workspace. If Savia asks you to sign in to that workspace, it opens **Bookings** after sign-in. The picker lists active commercial organizations you can access. If the list is empty, ask an administrator for access.
Platform administrators can open **Bookings** from the menu even without a
membership in a commercial organization.
If a background refresh fails temporarily, the selector keeps the last
confirmed organization list for the current session and offers a retry.
When the server denies access, the selector clears the list.
The sign-in return also works for links with a trailing slash or a
case-insensitive match of the Bookings route.
Signing in from the platform portal or local Admin also resumes Bookings on
the configured callback origin, including any requested tab and date.
Local development and branch Previews without dedicated workspace domains
list accessible organizations in the same deployment. Selecting one opens
Bookings on that origin. The selection survives signing in again, and the
API checks access to the selected organization on every Bookings request.
Changing the reservations date or leaving its tab cancels the pending list
request so its response cannot replace the current view.
When the date changes, the agenda hides the previous day's reservations and
pagination while the selected date is being read.

If a Bookings link specifies a tab or date, both the organization picker and
sign-in preserve those selections. Switching tabs updates the URL, so the
browser's Back and Forward buttons restore the previous view.
Changing the display language keeps unsaved booking settings in the open form.
Saving weekly hours in either **Booking settings** or **Availability** updates
untouched weekdays in the other editor. Weekdays edited in the other editor
stay in its draft until you save or reset it. Availability controls pause while
a save is in progress.
Each professional has a separate availability draft while Bookings is open.
Switching professionals preserves pending hours and exceptions. Saving applies
the selected professional's draft, so other professionals' drafts remain
available. The updated schedule keeps the current selection when that
professional is still available. A newer saved schedule updates untouched
exception dates and keeps pending additions, edits, and removals in the draft.
Changing workspaces resets the booking form and its saving state. Leaving Bookings
or choosing another workspace cancels any pending settings read. A response
from the previous workspace applies only to the request that sent it.
When sign-out starts, Bookings hides the organization picker and agenda,
cancels pending reads, and pauses new reads until the session is available.
If the organization list, workspace lookup, booking settings or reservations
require a new session, **Sign in again** returns to the same Bookings view with
its workspace, tab and date preserved. This also applies if the session expires
while saving booking settings, availability, calendar preferences, or My Day
access, or while cancelling a reservation or requesting a video link. After
signing in, review the current state before submitting the change again.
On a dedicated hostname, Bookings waits for a valid workspace. If the server
reports that the workspace is missing or inaccessible, **Retry** resolves it
again from the current tab and date.
On a Savia workspace hostname, **Choose another organization** opens the
Bookings picker for the same environment and keeps the requested tab and date.
This option is also available if the server rejects access while loading
booking settings or reservations after the workspace initially resolved.
If the identity provider returns an error during authorization or during the
code exchange for a valid Bookings transaction, **Sign in again** starts a new
transaction for the same workspace, tab, and date.
If the authentication page restarts access because the authorization or its MFA
challenge expired, the new sign-in retains the organization, tab, and date,
including when the API and organization use different hostnames.
When the final callback arrives within five minutes after the login transaction
expires, **Sign in again** preserves the same workspace and Bookings view.

Open **Bookings** in the tenant navigation. Administrators use a five-step setup wizard: **Details → Team → Services → Hours → Review and publish**. Details include the public title, description and IANA time zone; expand **Booking rules** to configure advance notice, booking horizon, cancellation cutoff and reminders. Add professionals from the tenant's users, assign them to services, then configure their weekly schedules. Moving between steps preserves unsaved edits. A service specifies its duration and trailing buffer. Durations, buffers and availability boundaries use five-minute increments; offered start times use fifteen-minute increments.

Each professional has weekly availability and date exceptions. An exception replaces that day's weekly periods; an empty exception closes the day. Periods cannot overlap or cross midnight. Administrators can configure all professionals. A professional can update their own availability without changing services or other professionals.

Availability validates weekly hours and exception periods before submitting.
If an exception is invalid, the message identifies its date. The form keeps
the draft for correction and shows the reason when the server rejects a save.
Clearing a time keeps the period in the draft for editing. Use **Remove period**
on the last interval to close the date.

When clocks change, the service and buffer must fit in the actual elapsed time
before the period ends. Missing or repeated local start times are skipped.
If the closing time occurs twice, the period ends at its first occurrence.
If the clock skips the closing time, the period ends at the clock change.
All-day Google calendar conflicts use the first instant of each local date,
including when midnight is skipped or repeated.
Outlook events marked free or cancelled are ignored before checking their
time intervals.

Use **Remove service** or **Remove professional** to remove an item from the draft. Removing a professional also clears their service assignments. Changes take effect only when saved; **Discard changes** restores the saved configuration. Existing reservations retain their history. **Save settings** keeps the chosen publication state, **Save draft** saves an unpublished configuration, and **Save and publish** enables and publishes it. A draft may have no services or professionals. Validation returns to the step that needs correction.

Publish when booking is enabled and an enabled service has an enabled professional assigned. Save the configuration before opening the public page; the link is offered only for saved, enabled and published settings. The form explains missing publication requirements before submitting. If the API rejects a save, its HTTP status and reason are shown, with known booking validation messages translated. Network failures retain the connection recovery message. Open the **Booking links** tab to create **My booking link**, bound to your configured professional, or an explicit **Team agenda** link. Customers following a personal link never select a professional. A single eligible service opens availability directly; several services add a service step. The public flow is **Service, if needed → Availability → Your details**. Availability uses a visible month calendar and time buttons together, stacked on mobile. Unavailable days are disabled, month navigation respects the booking horizon, and no time is selected until the customer clicks it. The display time zone defaults to the tenant zone and can be changed; calendar dates, times, summary, and confirmation then use that zone while reservation timestamps remain UTC. Customers review their selection, provide their name and email, and complete the configured captcha before confirming. Going back preserves their details; changing a service or professional clears the previous time. Refreshed availability must still include the selected time before proceeding. Public pages bypass the authenticated app and its offline storage. Their HTML uses no-store, no-referrer and noindex headers, and booking navigation is excluded from the service worker fallback. Public catalogs contain names and opaque booking identifiers, never internal principal identifiers or customer lists.

### Personal and team public links

The service options in **Booking links** come from saved settings. Draft
changes stay in the setup wizard and appear in the link selector after saving.

If your session expires while loading or managing links, **Sign in again**
returns to the **Booking links** tab in the same workspace. The tab reloads
the current list, so you can review it before trying the action again.
Leaving this tab cancels the pending list request.

New links default to a 30-day expiry and 25 admitted booking submissions per UTC day. Choose 24 hours, 7 days, 30 days, or explicitly no expiry; the daily budget can be configured from 1 to 1,000. Copy the canonical URL, use the device's share action, or show a QR code. Each link also receives a Savia short URL; when Shlink is configured, the short URL action uses it and falls back to the Savia URL if the provider is unavailable. Shortening does not grant different booking permissions.

Each link has independent revocation and deletion. Delete permanently removes the public link from the panel and invalidates its canonical and short URLs, including legacy team links; it does not delete reservations or their private management links. Personal links expose only enabled services assigned to their fixed professional; optional service-scoped links expose only that service. The server enforces this scope for the catalog, challenge, availability and reservation, including caller-submitted identifiers. Disabled professionals/services, removed membership, inactive tenants, expiry and unpublishing stop new bookings. Existing tenant-wide URLs remain team links and can be revoked or deleted through the same panel; they are never silently converted into personal links.

Changing the display language on a public booking link keeps the selected time and contact details. A retry with the same booking details retains the original request key and confirmation language, including after edits that only change email capitalization or spaces around the contact details. Each public link keeps its own form and confirmation state.
Deleting a link also stops submissions that are still in flight and have not
yet saved a reservation.
If the workspace is deactivated before a submission is admitted, the API
reports that the booking page is unavailable.
If submission fails because a link or booking option disappeared, the page
checks the link again. It shows the available options and keeps the customer's
contact details if the link still works, or asks the customer for a new link.
If a temporary connection or server error prevents a public booking link or private management link from opening, choose **Retry** to load the same link.
Public booking requests time out after 15 seconds, including while reading a response. If a booking submission times out, use the retry action to check its outcome with the original request key.
Refreshing availability also preserves the request key when the same start
instant is returned with an equivalent offset.
A successful retry shows the stored time and status, including changes or
cancellation made after the initial request.
If you go back to the calendar after a request whose outcome is unknown,
**Retry previous booking** uses the original details and request key even when
the selected time now appears occupied. If that retry needs fresh verification,
complete it in the previous booking panel and retry the same request.

When the per-minute request limit is reached, the public calendar and booking
form show when to retry if the server supplies a reset time.
Savia preserves the error status and retry deadline from the headers even
if the response body times out.
Opening or reloading the public link shares the calendar's read deadline. The
customer can retry loading the link once the deadline passes.
The booking form pauses new submissions until the advertised minute or daily
deadline passes. A rate-limited retry keeps any unconfirmed booking available
for recovery with the original request key.

When the form reloads its CAPTCHA after a language change or a return from the calendar, complete the new verification before submitting. If verification fails to load, **Retry verification** reloads the CAPTCHA and keeps the selected time and contact details.
When verification is rejected or the daily booking limit is reached, the form
requires fresh verification for a retry with the same booking details.
After a timeout or server error, retrying from the review step also uses fresh
verification and preserves the original request key.

Returning from the review step refreshes availability for the selected month. If availability cannot be loaded, retry to check the previously selected time. The form only lets you continue once it confirms that the time is still available.
If an availability request reaches the rate limit, the calendar keeps the
selected month and display time zone. It pauses availability requests until
the server's retry time. On a private link, the calendar and appointment
refresh share the same read deadline.

The selected date and its available times use the booking display time zone, which you can change in the calendar.
The last bookable date reflects the elapsed booking horizon in that time zone.
Changing the zone also moves the visible month into the bookable range when
needed.
During rescheduling, the current appointment time is excluded. Dates with no
other times are disabled.
Submitting the current instant with an equivalent time-zone offset does not
create a new reservation revision or delivery job.

Changing the display language on a management link keeps the selected time and review step when rescheduling. An in-progress change stays scoped to the appointment opened by that management link.

A reschedule confirmation uses the time zone chosen in the calendar. Refreshing the appointment hides that confirmation if the appointment has since moved or been cancelled.
Refreshing also closes an open reschedule review if the appointment changed time or can no longer be rescheduled. A refresh that only updates the conference link keeps the review open.

The management page closes the reschedule form and disables cancellation when the appointment's change deadline passes, including while the review step is open.

If saving or rescheduling an appointment returns an HTTP conflict, the form rechecks the appointment or refreshes available times as needed, even when the error response has no JSON details.
If the connection drops or the server returns a 5xx response while rescheduling, the management page checks whether the new time was saved. If the time is unchanged and the appointment can still be rescheduled, the customer can confirm the same selection again using the latest appointment version. If the appointment now has a different time, the page shows that time and closes the previous review.
The management page checks the appointment's current status to recover from cancellation failures such as a dropped connection or a version conflict. It displays a completed cancellation and uses the latest version if the customer chooses to retry an active appointment. If the appointment moved, the page shows the new time and closes any open reschedule review before the customer can retry.
When a cancellation or reschedule request is rate-limited, the page preserves
the appointment and any selected time. It displays the retry time supplied by
the server, pauses both actions until then, and waits for the customer to
confirm another attempt.
The private link also pauses retries when the server rate-limits opening or
refreshing the appointment. If a change is still unverified, the customer must
refresh the appointment successfully before making another change.
If an appointment refresh reports that the private management link is no longer
available, the page hides the previous appointment details and actions and asks
the customer to contact the booking owner. The same applies when the page checks
the appointment after a failed cancellation or reschedule.

Expiry and revocation do not delete reservations or invalidate their distinct private management links. Deleting a public link has the same preservation behavior. Management and cancellation policies below continue to apply.

Public booking admission also limits each hashed client IP to 20 submissions and each tenant to 1,000 submissions per UTC day. When a daily limit is reached, the API sends the next UTC midnight in the `Retry-After` header, and the booking form shows that time in the customer's browser time zone. Failed admitted attempts consume the budget; retrying identical details with the same request key reuses admission and does not consume it twice. Changing the payload under that key conflicts. Persistent minute limits and CAPTCHA remain in force; browsing calendar days does not consume submission budgets. Public body size is limited to 32 KiB. A bounded range contains at most 31 dates. If working hours and booking rules leave candidate times, Savia checks each calendar once, from the earliest candidate through the final appointment and its buffer. Unknown calendar availability stops booking with a retryable error.

## Reservations and management

Administrators see the tenant's reservations; other tenant members see only reservations assigned to themselves. Concurrent native bookings claim the professional's occupied intervals atomically, including the trailing buffer. Conflicting requests return a recoverable conflict and create no partial reservation. Request keys prevent duplicate reservations when a customer retries a submission.

When the selected date range contains more than 500 reservations, use
**Load more reservations** to continue through the same range.
Reservation dates and the upcoming range use the saved booking settings.
Changes to the time zone or booking horizon take effect after saving.
Saving Availability updates the selected professional's saved schedule. An
unsaved Booking settings draft remains available in its own tab.
Changing calendar or My Day access preserves that draft and its version.
It also keeps edits in the availability editor when the saved schedule version
has not changed.
If pages overlap, the list keeps each reservation once and preserves the
newest version already loaded.
If cancellation or video link generation fails, the error appears beside the
reservation and the list stays open.
While a reservation update is pending, its other actions stay disabled.
Actions on different reservations can continue independently.
A refresh that was already in flight does not restore a reservation's older
state after a successful cancellation or video link request.
If a cancellation succeeds and the response is lost, retrying from the same
reservation revision returns the saved cancellation without adding new jobs.

Confirmed appointments also appear in the assigned professional's **My Day**
agenda, in day, week and month views, even without Google Calendar or Outlook.
My Day shows only the signed-in user's assignments across their current commercial
workspace memberships; administrators use **Bookings → Reservations** for team
history. Appointment details link to authenticated workspace reservations where
tenant hostnames are supported, opening the appointment date in the workspace's
configured booking time zone. The date filter uses that same time zone.
**Show upcoming reservations** clears that date. Details never expose the customer's private
management token. Rescheduling and cancellation are reflected when My Day
refreshes, including **Synchronize**, focus/connectivity recovery and visible
five-minute polling. See [My Day widgets](../my-day-widgets.md).

The confirmation contains a private management link. Anyone possessing this link can view, cancel or reschedule that single reservation, so treat it as private. Customers can change a confirmed reservation before the tenant's cutoff. Cancelled reservations release their intervals. Rescheduling replaces the old occupancy atomically and keeps the old time if the new time conflicts. Changing a service's duration or buffer requires contacting the business before rescheduling an existing reservation. Administrators and assigned professionals can cancel through their authenticated agenda without the customer cutoff.

Choose **Reschedule** from the private management page to use the same inline calendar, time buttons and display time zone as a new booking. The service and professional remain fixed to the reservation. Choose a different time, review the existing and proposed appointment, then confirm the change; navigating back or leaving the editor does not change the appointment. Successful changes refresh the reservation's revision and retain its private management link. A stale slot returns to refreshed availability; an identical retry after a lost success response checks the current appointment before claiming success.

If the management page cannot verify the result of a cancellation or reschedule,
choose **Refresh appointment**. Further changes are available once the page has
loaded the current reservation and confirmed it can still be changed.

If the server rejects availability while the calendar is open, the management
page rechecks the appointment and closes the calendar if the appointment moved
or can no longer be rescheduled.
If the service duration or buffer changes, the API reports the changed service
before checking connected calendar availability.
The current and proposed times both show the applicable time zone designation
so repeated local hours during daylight saving time changes can be distinguished.

Private calendar availability is scoped to the reservation's token and is independent of public sharing-link expiry or revocation. It excludes that reservation's native occupied intervals while retaining all other appointments and external calendar busy periods. Rescheduling is unavailable after the cutoff or when the tenant, professional, service or original duration/buffer no longer permits it; the page explains how to contact the business. Viewing and eligible cancellation remain available under their existing rules. The link to book another appointment appears only when the tenant-wide public link remains available.

Unpublishing stops new public bookings. Existing management links continue to support viewing and cancellation; rescheduling requires published booking settings. Removing or disabling a professional does not erase historical reservations. Deactivated tenants retain existing private management links and authorized reservation history and cancellation; public booking and rescheduling stay blocked. Delivery jobs stop while the tenant is inactive.

## Optional calendars through Nango

To avoid conflicts with the rest of your My Day agenda, use **Bookings → Availability → My Day availability → Use My Day to block busy times**. Each professional grants access to their own current Google and Outlook connections and imported or subscribed calendars. Only occupied time intervals influence public availability; meeting names, attendees, links and calendar credentials remain private. Hidden calendars remain conflict sources: hiding a calendar is a display preference, not a release of its occupied time. Events explicitly marked free and cancelled events do not block slots. All-day events use the source time zone and exclusive end date; recurring events retain their exceptions.

When a clock change skips midnight, an all-day event starts at the first
available time on its local date.

Authorization is tenant-scoped and snapshots source identities. Use **Update calendar access** after adding a calendar or reconnecting an account, or **Stop using My Day** to revoke this additional access. Administrators cannot authorize another professional's agenda. The separate calendar choice below still controls where appointment events are created.

Availability and confirmation/rescheduling share the same conflict check, including appointment duration and trailing buffer. Subscriptions are refreshed again when confirming or rescheduling. A failed or stale authorized source stops booking instead of presenting unknown time as free. When another meeting or appointment occupies the requested interval, the form explains the conflict and reloads available times while preserving customer details. Reprogramming excludes only the appointment's saved event in the same connected account; another overlapping meeting still blocks the move. External providers cannot participate in the booking transaction, so changes made outside Savia after its final check can still require review.

Connect a personal Google Calendar or Outlook integration first. Each professional then explicitly grants booking access to their own connected calendar. Administrators cannot grant access to someone else's personal integration. Grants are scoped to the tenant and pinned to the connection; reconnecting requires a fresh grant.

Availability checks the Google primary calendar or the user's Outlook calendar. Google uses its complete free/busy response; Outlook follows pagination. Malformed responses, disconnected grants and provider failures stop new bookings instead of treating unknown availability as free. A professional may revoke the booking grant and use only the native agenda.

Calendar jobs create, update or cancel a corresponding event. Google events use a deterministic identifier; Outlook events use a transaction identifier and a persistent booking marker to recover an event when a creation response is lost. Revoked grants do not authorize further external writes. Rescheduling ignores only this appointment's saved event in the same connected account; other meetings still block the requested interval. External calendar providers do not participate in Savia's database transaction, so simultaneous changes made outside Savia can still conflict and require review.

The authenticated **Reservations** list shows each reservation's saved calendar provider and its current delivery state. A completed calendar job is shown as saved only when Savia also has evidence of the provider event; otherwise the list reports that no event was saved. Pending and failed calendar writes remain visible, and a reservation without a calendar request is marked **Not requested**. Cancelling requires confirmation; the reservation remains in history as cancelled, and Savia requests cancellation of the linked provider event and video meeting when a calendar grant was saved. Calendar cancellation remains pending or failed until its job completes.

### Video calls

In **Bookings → Settings → Details**, choose **Video meeting provider**. The
backward-compatible default is **Automatic (Google Meet or Teams)**. With that
option, when a professional has granted calendar access, new appointments request
a video call if that calendar advertises support: Google Meet for Google Calendar,
or Teams for Outlook. Savia checks the actual calendar capabilities; connecting
an account alone does not guarantee conferencing support. A calendar without the
capability still receives an ordinary appointment. Professionals can instead
connect Zoom and select **Bookings → Availability → Use Zoom for appointments**.
This explicitly grants their current Zoom connection to this tenant, alongside
the destination calendar. New reservations then create a Zoom meeting and store
its attendee link in that calendar event. A reservation administrator cannot
grant another professional's personal Zoom account. Choosing **Calendar default
(Meet or Teams)** revokes the Zoom grant for the tenant and uses native calendar
conferencing for new appointments.

For an existing reservation without a ready or pending link, choose Zoom under
**Reservations → Video call platform → Generate video link** when its assigned
professional has authorized Zoom. An unsupported native Meet/Teams capability
does not prevent using an authorized Zoom account. Existing ready/pending links
are retained. Rescheduling updates the same Zoom meeting; cancellation deletes
it through the original authorized connection. Revoked or replaced connections
stop external changes until access can be safely restored. No host start URL is
exposed. See [Zoom setup](zoom-integration.md). The tenant’s Jitsi setting takes
precedence over this personal Zoom default.

Choose **Jitsi** to give each new reservation a unique room on `meet.jit.si`.
Savia saves the room before queuing delivery, so confirmation and reminder emails
include the same link even without an external calendar grant. A connected
calendar receives that link in its event details instead of creating a Meet or
Teams call. Changes to the default apply only to new reservations; rescheduling,
delivery retries and calendar grant failures preserve the existing room.

The Jitsi join action is also available on native appointments in **My Day**.
Cancelling hides the join action in Savia but cannot revoke a public Jitsi URL.
This version uses the public Jitsi service, whose host authentication and service
policies apply; it does not deploy a Jitsi server or implement JaaS tokens. See
[Jitsi meetings](jitsi-meetings.md) for invitations from My Day.

The Nango Google connection must allow calendar metadata reads in addition to
event writes and free/busy reads. The narrowly scoped combination is
`https://www.googleapis.com/auth/calendar.events`,
`https://www.googleapis.com/auth/calendar.calendars.readonly`, and
`https://www.googleapis.com/auth/calendar.events.freebusy`. Outlook uses delegated
`Calendars.ReadWrite` for calendar metadata and event operations. Existing
connections with narrower scopes may need reauthorization before provisioning
can succeed; Savia does not expand consent automatically.

Provisioning runs through the existing background calendar jobs after the native
reservation is confirmed. The reservation stores the external event identifier,
meeting provider, link, and provisioning state. Pending links reuse the same event
on bounded retries (up to five job attempts); a provider failure never cancels the
native reservation. Unknown calendar capabilities are retried instead of being
silently treated as unsupported. A final failure is shown as unavailable rather
than leaving a permanent pending indicator.

Open the appointment in **Bookings → Reservations**, or use its private management
link, to view the call status and join a ready meeting. Refresh the appointment
after pending provisioning. Customer confirmation screens can show the returned
status; the management page contains the latest saved result. Emails include a
ready call link when it has already been saved; an earlier confirmation email
still includes the private management link. No video link is exposed in public
catalogs or availability results.

For an existing confirmed reservation without a meeting link, an administrator
or the assigned professional can choose **Generate video link** in
**Bookings → Reservations**. The action uses the assigned professional's current
calendar grant and requires an active connected Google Calendar or Outlook
account with meeting support. It reuses the reservation's provider event, keeps
the reservation confirmed, and reports pending work through the existing calendar
status. Repeated requests while a link is ready or pending are safe; a request
made during an active calendar job can be retried after that job finishes.
Retrying a failed Google Meet request starts a fresh conference request on the
same event; pending and ready conferences are preserved.

Rescheduling updates the existing calendar event and preserves its call. Cancelling
hides the join action immediately and queues deletion of the same provider event.
Links are accepted only as HTTPS participant URLs. The existing tenant grant,
professional membership and pinned Nango connection checks apply to every job.
Teams link validation includes the documented [sovereign cloud client hosts](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/sovereign-cloud)
as well as commercial Teams hosts; the connection must still be configured for
the correct cloud. Refreshing a pending link cannot overwrite a later appointment
cancellation or reschedule.

Deploy `0028_booking_conferences.sql` and the forward migration
`0033_booking_jitsi_conference.sql` for D1 and PostgreSQL before the updated API. No live provider calls are required by the automated
fixtures; live account, policy and license compatibility still needs verification
in the target environment.

## Email and delivery status

Confirmation, rescheduling, cancellation and optional reminder messages use the tenant's configured outbound mail first, or the existing global SMTP/transactional fallback when tenant mail is unconfigured. Mail setup is optional for booking: without a transport, the reservation is confirmed and delivery is marked skipped with `BOOKING_EMAIL_NOT_CONFIGURED`. A configuration-read or delivery failure remains retryable and does not undo the reservation. Configure mail under the existing tenant email settings; a contact address alone is not a sending transport. Messages include the customer, service, professional, start/end, duration, time zone and private management link. The customer locale is saved as English, Spanish or Portuguese at creation; older reservations default to English. Delivery and calendar status appear separately from reservation status: a reservation remains confirmed while delivery is pending or failed. Calendar labels use the provider saved on that reservation, not the professional's current connected account.

The scheduler processes a durable outbox, leases work and retries transient errors up to five times. A per-reservation lock orders delivery across concurrent schedulers. Reservation changes return a retryable conflict while an active delivery lease is held. Reminder jobs for an old revision or a cancelled appointment are skipped. SMTP delivery is at least once: a crash after SMTP acceptance but before persistence can produce a duplicate message. Terminal failures remain visible and require correcting the provider configuration and operational intervention.

## Deployment and verification

Both SQLite/D1 and PostgreSQL have forward migrations `0022_tenant_bookings.sql`, `0026_booking_public_links.sql`, `0027_booking_public_link_short_urls.sql` and `0029_booking_agenda_grants.sql`. Migration `0026` adds scoped links, daily admission receipts and stored customer locale, and preserves existing tenant URLs as independently revocable team links. Migration `0027` adds short URL storage and deletion tombstones. Migration `0029` stores each professional's tenant-scoped My Day availability grant. Apply the D1 migration before deploying the updated API. Existing tenants remain disabled until configured. API reference is generated from the Booking OpenAPI routes.

Public requests enforce body limits, per-link request throttling, no-cache and no-referrer headers, and captcha verification. ALTCHA proofs are consumed once; retrying the same confirmed request key returns the existing reservation. Captcha bypass is limited to local development origins.

Admission hashes are retained for seven days so failed requests can be retried without consuming another daily admission. The scheduled booking worker removes up to 500 older receipts per pass. Confirmed reservations retain their own idempotency record and private management link.
