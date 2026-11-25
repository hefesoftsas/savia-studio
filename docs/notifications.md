# Notifications

Durable, permission-aware personal inbox for collection activity, assigned work,
administrator messages, and supported authentication events.

## Sources

- **Collection activity** (`created`/`updated`/`deleted`, restore, purge): native
  database triggers in `0061_notification_collection_triggers.sql` /
  `0021_notification_collection_triggers.sql` /
  `0004_notification_collection_triggers.sql` capture writes and fan out to
  collection followers, excluding the acting user. Actor attribution reuses
  `crm_record_history_context`.
- **Workflow tasks**: `processWorkflows` appends a notice alongside each task
  insertion in the same checkpoint transaction, so a failed checkpoint rolls
  back both. Delivery checks that the task is still assigned to the recipient
  in the originating workspace. `backfillWorkflowNotices` covers items created
  before capture.
- **Administrator messages**: `sendAdminNotice` with idempotency keys, 10/min
  per actor/workspace quota (429), audit rows, and delivery status.
  A retry of the same message reuses the original event without spending quota
  again. The event, quota increment, and audit entry commit together.
- **Authentication**: `apps/auth` persists `email-verified` and
  `two-factor-enabled` transitions as source events; `apps/api` imports them
  across the service boundary (`importAuthNoticeEvents`) with an explicit
  bridge key (`SAVIA_INTERNAL_BRIDGE_KEY`) and idempotent acknowledgement.

## Delivery

Events are captured transactionally; a bounded, leased dispatcher
(`processNotifications`, 60s leases, fencing tokens) fans out recipient rows.
Retry schedule after a failed attempt: ~1, 5, 15, 60, 240 minutes with jitter;
five failures persist until a manual retry. Ready recipients continue in
subsequent batches while another recipient waits. Budgets per tick: 50 events, 100 recipients per event,
1,000 recipient attempts, 20s soft budget. A later tick resumes after the last
recipient processed when a budget is reached. `runScheduledNotifications` runs on
both workflow scheduler paths. The retired customer-profile CRM synchronization
worker is no longer part of the scheduler.

## Inbox

- `GET /api/notifications?filter=all|unread|pending&cursor&limit` (default 30,
  max 100), opaque `(createdAt,id)` cursors, `GET /count`, read/archive/read-all
  (bulk reads are idempotent, capped at 100 with resumable cursors).
- **Mark all as read** follows every cursor and covers account notices and
  notices from the current workspace.
- You can mark individual account or workspace notices as read or archive them
  from the same inbox. Archiving removes a notice from inbox filters and counts
  and preserves it for the archive retention period.
- Task notices stay pageable when the inbox contains more than 100 distinct
  tasks. A notice whose task is missing remains visible as unavailable.
  Task status and pending counts use the workspace that issued the notice.
- **Load older notifications** adds the next page in the current filter.
  If it fails, you can retry while the loaded notices stay visible.
  Inbox reads use bounded batches, including when pending notices are sparse.
- Actions resolve only assigned workflow tasks and administrator
  acknowledgements. Account security notices link to account settings.
- Administrators can require confirmation of receipt. Those messages stay in
  **Pending** after being read and leave it when the recipient confirms receipt.
- UI: bell with 30s polling in the header, `/notifications` route with
  all/unread/pending filters, follow controls on collection pages, and an
  administrator message screen with delivery status.
- Failed deliveries: inspect `GET /api/notifications/admin/:eventId/status`,
  retry with `POST .../retry`. Both actions require administrator permission
  in the workspace that sent the notice. A manual retry reopens completed
  notices with failures without redelivering to existing recipients.
  Retention: read/archived 90 days, unread
  180 days (configurable per workspace, unresolved tasks and pending security
  requests are protected). Bounded cleanup batches continue past protected
  notices and verify open tasks in their original workspace. Disabling dispatch pauses delivery without deleting
  committed events.

## Migration order

Apply host/standalone/auth schema changes before deploying producers
(`0060`/`0020`/`0003`, then `0061`/`0021`/`0004`). Deploy consumer APIs and
the dispatcher, then producers and UI; run the workflow backfill after capture
is active. Rollback preserves new tables and source events until compatible
consumers resume.

Latency is roughly one scheduler interval plus up to 30s of UI polling.
Database capacity: recipient fan-out is bounded per tick; large audiences drain
over successive ticks (see dispatch report backlog).
