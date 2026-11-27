# Low-code fields

The screen designer exposes the existing text, contact, address, map, numeric,
currency, option, boolean, date, attachment and presentation controls. It also
provides **Date and time** (`DateTime`) and **Time** (`Time`) in the field palette
and type selector. These controls use the same registry in ordinary forms and
related-record forms.

## Temporal values

- `DateControl` stores a calendar date as `YYYY-MM-DD`. Tables and details format
  it without converting it to the viewer's time zone or changing its day.
- `DateTime` edits a date and time in the browser's local time zone. The backend
  requires an ISO timestamp with an explicit offset and normalizes it to UTC.
  Tables, details and conversation summaries display it in the viewer's local
  time zone. Defaults entered in the designer follow the same conversion.
- `Time` stores a minute-precision wall-clock time as `HH:mm`, without a date or
  time zone. It is suitable for recurring opening times, not an instant in time.
- Existing fields configured with `config.dateTime: true` retain their editor
  and are validated and displayed as timestamps. Date-only values supplied to
  those fields must be corrected to an explicit timestamp.

Impossible calendar dates, timezone-free timestamps, and invalid times are
rejected by the shared validation used in the backend. Both dedicated temporal
field types can be selected for record history. No database migration is needed;
values continue to use the collection's JSON record storage.

## Display consistency

Tables, record details and conversation summaries share field formatting for
calendar dates, timestamps, currencies, option labels, boolean values and map
locations. Empty values display an em dash in tables and details, while
conversation summaries retain their incomplete-answer indicator. Zero and false
remain visible values. Existing relation and attachment controls retain their
specialized displays. Currency formatting uses the configured currency and
precision, defaulting to COP and two decimals.

## Attachments

Each file shows its own progress when several files are selected in the same
field. The form waits for all active uploads before continuing or saving.
For workspaces with collection permissions, a temporary attachment belongs to
its uploader and the intended record or create request. Savia checks the field
grant and rechecks the record permissions before associating the file.
If the attachment list fails to load, use **Retry**. After an interrupted
deletion response, Savia shows the error and reloads the list to reflect the
server's current attachments.

Deleting an attachment removes it from the record and queues its stored file and
revisions for removal. If the storage service is unavailable, scheduled
maintenance retries the pending deletion.

Studio reports an upload error when the server starts sending the confirmation
but the response takes longer than the standard 15-second response deadline.
For existing records, refresh the attachment list before repeating the upload.
The server may already have saved the file when the confirmation was interrupted.
If the database reply is interrupted, Savia checks whether the upload was saved
before confirming it. Storage left by an unsuccessful upload is queued for cleanup.

If a selected attachment expires while the form is open, Savia uploads the
selected file again and asks you to save once the upload finishes. If the record
is already saved, re-uploading uses its current edit permissions and keeps the
same record.

When a confirmation stalls while associating temporary attachments, save the
record again. Savia recognizes attachments already associated with that record
and continues with the pending attachments. If an attachment was edited since
the first save, Savia verifies its original association in the revision history
and returns the current file version.
The retry reuses the confirmed record when its fields are unchanged. If any
fields were edited after that confirmation, Savia saves those changes first.

Concurrent uploads share the field and record limits. Savia automatically retries
a temporary database write conflict without uploading the file again. If another
upload fills the remaining slot, Savia reports the limit and keeps a temporary
attachment available to retry after space is freed.

Cancelling closes the form immediately and discards any remaining drafts in
the background. Drafts still present on the server expire after 24 hours.
Scheduled maintenance removes expired drafts even when nobody opens the form again.
Uploads, associations, and download attempts for expired drafts can also trigger
cleanup. If storage is unavailable, a later cleanup attempt retries the deletion.
Expired drafts remain unavailable during that time, valid uploads can proceed,
and associated files stay with their records.

## Multiple choice

`MultiSelect` stores a JSON array of distinct option values. The designer provides
an option list and multiple default selections. Forms show labeled checkboxes;
tables, details and summaries show the saved option labels as tags. Required
fields must have at least one choice. Unknown values and non-string choices are
rejected. Empty optional choices become an empty array. CSV cells use JSON arrays
such as `["priority", "renewal"]`; normal CSV quoting applies.

This type uses static options. Relationship selectors, dependent choices,
uniqueness and external option sources retain their existing dedicated controls.

Relationship selectors preserve the current results page until the search text
changes. A changed search returns to page 1 after the 250 ms debounce; opening
the selector alone does not reset pagination. Selected records remain selected
when paging or searching.

## Rich text

`RichText` stores Markdown as a string, with a default maximum of 100,000
characters. Its editor offers bold, italic, bulleted lists, numbered lists, links
and a preview. It is a Markdown editor with formatting shortcuts, not a WYSIWYG
HTML editor. Required values cannot contain whitespace alone. The designer can
set minimum and maximum lengths, enforced when saving.

Tables, details and summaries render supported Markdown formatting and omit raw
HTML, scripts and images. Links support HTTP, HTTPS and mailto. Unsupported
destinations render as plain text. Web links open in a new tab so the form stays
open. Mail links use the configured email handler. Existing HTML presentation
blocks are separate from editable rich-text data. Record history supports rich
text. Multi-select history remains unsupported.

## Percentage and rating

`Percentage` stores a number in percent units: `25` means 25%, not 0.25. Its
initial range is 0–100, with at most two decimal places. The designer can change
the minimum, maximum and precision (0–6 decimal places). Saving rejects values
outside those bounds or with excess precision rather than silently rounding.
Tables, details and summaries append the percent sign using locale formatting.

`Rating` stores an integer from 1 to a configurable maximum of 1–10 (default 5).
The designer chooses stars or numeric entry. Star controls support keyboard
navigation, read-only display and clearing; a cleared required rating fails
validation. Tables, details and summaries show stars or the score and maximum.
An empty value is distinct from a score; zero is not a valid rating.

Both types support numeric CSV import, numeric filter operands, field conversion
and record history. Access-policy comparisons enforce numeric literals. General
formula outputs and automatic monetary summary inference retain their existing
Number/Currency scope. No database migration is required.

## Localized labels

Field and static option editors support ES/EN/PT label overrides. Empty overrides
fall back to the default label; option values and saved records remain unchanged.
See [Core localization](localization.md) for formatting and validation behavior.
