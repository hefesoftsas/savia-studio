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
  before capture, resumes by task ID and workspace, and reuses existing notices.
  A legacy checkpoint containing only a task ID restarts the scan to recover
  tasks skipped by the earlier cursor.
- **Administrator messages**: `sendAdminNotice` with idempotency keys, 10/min
  per actor/workspace quota (429), audit rows, and delivery status.
  Send keys support up to 200 characters.
  A retry of the same message reuses the original event without spending quota
  again. The event, quota increment, and audit entry commit together.
  A send with zero deliveries remains visible for the workspace's read
  retention period. Reusing its audited key after cleanup returns a conflict.
- **Authentication**: `apps/auth` persists `email-verified` and
  `two-factor-enabled` transitions as source events; `apps/api` imports them
  across the service boundary (`importAuthNoticeEvents`) with an explicit
  bridge key (`SAVIA_INTERNAL_BRIDGE_KEY`) and idempotent acknowledgement.

## Delivery

Events are captured transactionally; a bounded, leased dispatcher
(`processNotifications`, 60s leases, fencing tokens) fans out recipient rows.
Invalid queued events are marked failed so delivery can continue for later
events.
Retry schedule after a failed attempt: ~1, 5, 15, 60, 240 minutes with jitter;
five failures persist until a manual retry. A retry is cleared when the
recipient leaves the audience or the dispatcher confirms loss of access.
Temporary read failures during permission checks trigger retries.
Delivery checks the recipient's scope before reading any source-specific access
data, and loads the recipient's identity once per attempt.
If an audience lookup fails, the dispatcher saves progress, reschedules that
notice from the last recipient processed, and continues with other notices.
Due retries behind the audience cursor are revisited on a subsequent pass.
Ready recipients continue in subsequent batches while another recipient waits.
Member and follower audiences load one page of principal IDs at a time.
Budgets per tick: 50 events, 100 recipients per event, 1,000 recipient attempts,
20s soft budget. The dispatcher checks time between recipients and commits its
progress before exiting. A later tick resumes after the last recipient
processed. `runScheduledNotifications` runs on
both workflow scheduler paths. The retired customer-profile CRM synchronization
worker is no longer part of the scheduler.

## Inbox

- `GET /api/notifications?filter=all|unread|pending&cursor&limit` (default 30,
  max 100), opaque `(createdAt,id)` cursors, `GET /count`, read/archive/read-all
  (bulk reads are idempotent, capped at 100 with resumable cursors).
  Cursors support Unicode delivery IDs and remain compatible with earlier
  cursors. Invalid cursor contents return HTTP 400.
- **Mark all as read** follows every cursor and covers account notices and
  notices from the current workspace. While the inbox stays open, retrying
  after a partial failure resumes the failed batch from its saved cursor.
  The API accepts an empty body for the first batch and rejects malformed or
  invalid JSON bodies before changing any notices.
- You can mark individual account or workspace notices as read or archive them
  from the same inbox. Archiving removes a notice from **All** and **Unread**
  and preserves it for the archive retention period.
- Task notices stay pageable when the inbox contains more than 100 distinct
  tasks. A notice whose task is missing or assigned to someone else remains
  in **All** without a completion action. Task status and pending counts use
  the workspace that issued the notice and its current task assignment.
- **Load older notifications** adds the next page in the current filter.
  If it fails, you can retry while the loaded notices stay visible.
  Inbox reads use bounded batches, including when pending notices are sparse.
- A notice with incomplete stored content appears as **Notification
  unavailable** and can still be marked read or archived.
- Actions resolve only assigned workflow tasks and administrator
  acknowledgements. Retrying completion of an already completed assigned task
  returns success. Account security notices link to account settings.
- Administrators can require confirmation of receipt. Those messages stay in
  **Pending** after being read or archived, until the recipient confirms
  receipt or the notice reaches its retention limit.
- UI: notification bell in the header, `/notifications` route with
  all/unread/pending filters, follow controls on collection pages, and an
  administrator message screen with delivery status.
  The unread count refreshes on realtime events and when a stale count is
  shown as the menu opens. The menu shows loading and retry states while
  the count is unavailable.
  Each notification request times out after 15 seconds, including while
  reading the response. The inbox offers **Retry** if loading fails.
  Collection follow controls offer a retry if their initial state cannot be
  loaded.
  Follow requests require an existing collection in the current workspace.
  Deleting a collection removes its follows. Recreating a collection with the
  same name does not restore follows removed by the deletion.
- If the delivery status fails to load, use **Retry** in the status panel
  to fetch it again.
- Failed deliveries: inspect `GET /api/notifications/admin/:eventId/status`,
  retry with `POST .../retry`. Both actions require administrator permission
  in the workspace that sent the notice. A manual retry reopens completed
  notices with failures without redelivering to existing recipients.
  Retention: read/archived 90 days, unread
  180 days (configurable per workspace, unresolved tasks and pending security
  requests are protected). Bounded cleanup batches continue past protected
  notices and verify open tasks in their original workspace using only the
  current delivery batch. Migration `0064_notification_delivery_retention.sql`
  adds the cursor index in both SQLite and PostgreSQL. If the read state
  changes during cleanup, the next scan applies the updated retention period.
  Cleanup keeps
  events with recipient retry records so failed deliveries remain available
  for inspection and retry. Disabling dispatch pauses delivery without
  deleting committed events.

## Migration order

Apply host/standalone/auth schema changes before deploying producers
(`0060`/`0020`/`0003`, then `0061`/`0021`/`0004`). Deploy consumer APIs and
the dispatcher, then producers and UI; run the workflow backfill after capture
is active. Rollback preserves new tables and source events until compatible
consumers resume.

Latency is roughly one scheduler interval plus up to 30s of UI polling.
Database capacity: recipient fan-out is bounded per tick; large audiences drain
over successive ticks (see dispatch report backlog).
