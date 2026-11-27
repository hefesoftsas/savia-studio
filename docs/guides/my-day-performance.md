# My Day loading and refresh behavior

My Day reads its widget layout and calendar events from the backend. The admin
keeps a short-lived, in-memory copy for the current signed-in session so that
returning to the page can show the last result while it refreshes from the
server. This copy is discarded when the session is cleared or the authenticated
identity changes; it is never written to browser storage.

Calendar providers load independently after the connected calendars are known.
As each provider responds, its events appear without waiting for slower
providers. A failed provider is reported as a partial synchronization failure;
events already shown for that provider remain visible during refresh. An
explicit refresh checks connections and events again, and events created from
the quick task form are added immediately so a later provider response cannot
hide a newly created task.

The server remains authoritative for both widget layout and calendar data. The
in-memory copy is only a display aid between route mounts, and older in-flight
responses are discarded after a newer refresh or an identity change.

New widget IDs use the `w_` prefix followed by twelve uniformly selected
lowercase letters or digits.

The optional Office documents widget reads recent Savia and connected-drive
documents only while Office suite is enabled for the active tenant. It shows at
most five links ordered by their most recent update or creation time. It does
not cache document details in browser storage, and it refreshes when the
identity, active tenant, Office settings, or connected integrations change.

If HubSpot rejects a grouped widget summary as unsupported for the requested
data, My Day still shows the collection count when a separate total is
available. The widget indicates that the status breakdown is unavailable.
It also preserves a valid total when a response contains an invalid status
count or omits a requested amount.
If HubSpot returns an invalid amount, Savia continues verifying the record
count and omits the affected group's amount. My Day shows the verified total
and marks the requested breakdown as unavailable.
When HubSpot returns the same record twice during a scan, Savia reports a
provider error instead of counting it twice.
It also rejects a provider total below the number of records already scanned.
Changing a widget's collection, grouping, or due-date field hides the
previous result until the new data is ready. This applies to summary, items,
chart, and actions widgets.
On a temporary data refresh failure, these widgets keep the latest result
for that selection and offer a retry. An authorization failure removes the
previous result.
When a collection source sends a retry time, My Day keeps the latest result
for the current selection in its summary, items, chart, or actions widget.
**Retry** becomes available at that time. Manual and live data refreshes wait
until then, even if the widget settings or collection metadata change.
Background collection metadata refreshes also keep the current widget visible
during a temporary failure. A denied or missing collection removes its results.
Collection widgets hide the previous session's data as soon as the session
is cleared and skip new reads while explicit logout finishes.
Live refresh notices and queued events are discarded when the signed-in
account changes. Collection widgets also discard queued refreshes when they
switch collections, including within the same organization.
They cancel obsolete collection reads when the selection changes or the
widget closes. When the API receives the cancellation signal, it stops making
requests for that HubSpot summary.
The gateway and API opt into Cloudflare's
[incoming request cancellation flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests).

Plugin widgets verify installation for the current organization and session
before loading plugin content. Changing scope or starting logout cancels the
previous verification. If verification fails, use **Retry** on the widget.

The add-widget dialog uses the current session's authorized workspaces and
clears the previous collection when the workspace changes. It loads collection
fields alongside the collection list. Workspace, collection, and plugin catalog
failures can be retried separately. Standard collection widgets remain
available when the plugin catalog is temporarily unavailable.
The workspace catalog cache is scoped to the API client and authenticated
session. Responses started before catalog invalidation are discarded.

The agenda now reads selected day/week/month ranges. OAuth caches are keyed by
the requested range; shared-source display caches also include the display
timezone and keep at most sixteen ranges per client. Switching ranges cannot
display a previous range's rows while the new range loads. Removing or modifying
a source invalidates cached source ranges. Session/identity events clear private
state and obsolete responses cannot restore it.

Added iCalendar sources use an independent caller-owned D1 repository. Feed
bodies and URL tokens are encrypted; imported files are persisted snapshots.
Subscriptions use a five-minute freshness window, conditional HTTP validators,
and bounded server fetch/parsing. Ordinary range reads reuse fresh bodies and
expand only the requested occurrences. Manual Synchronize bypasses freshness.
Revision checks stop old upstream responses from replacing edited/deleted rows.

Visible online pages refresh calendars every five minutes and refresh on focus
or connectivity recovery. Timers pause reads while hidden/offline and are removed
on unmount. There is no background job or provider push subscription. Pending
source reads share a request, and successes publish without waiting for slower
sources. Transient failures retain last successful rows with a stale/error notice;
denied access clears private rows. Google/Outlook follow bounded continuation
pages so a busy month does not stop after the first 25/50 events. Source/page/
occurrence limits fail explicitly rather than reporting a truncated success.

Native Savia appointments use one authenticated range read across the caller's
commercial workspace memberships, rather than a request per tenant or calendar
connection. The server fixes the principal to the session and checks current
persisted membership. Reads include overlapping confirmed appointments and reject
ranges above 62 days or results above 2,000 appointments. There is no OAuth
requirement and no management capability token in the response.

Native appointment state stays in memory. Range, client and session changes clear
private rows and invalidate pending responses. Same-range transient failures keep
previous rows with a retry notice; denied access clears them. Manual refresh,
focus/connectivity recovery and visible five-minute polling read updated booking
state, so reschedules move and cancellations disappear. Exact external event
identities tied to the current connection suppress provider copies; title/time
matching is not used.
