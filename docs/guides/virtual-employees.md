# Virtual AI employees

Virtual employees belong to one commercial tenant. Their instructions,
knowledge files, and collection allowlists stay within that tenant. Employees
created by a platform administrator in the platform workspace are platform
defaults; Savia does not automatically share them with commercial tenants.

Employee discovery, detail, edits, deletion, file upload and removal, chat, and
MCP invocation all resolve against the same tenant scope. A caller with one
active commercial membership can use that tenant when no active tenant has been
saved. A caller with multiple or no active memberships must select an authorized
tenant. Platform administrators without a selected tenant operate on platform
employees and platform collections.

In a Savia chat turn, Studio queries use the organization resolved when the
turn starts. An organization change applies to the next turn. Studio still
checks the caller's current permissions on each request.

Confirmations for Studio record changes and optional quote actions use the
organization saved with the proposal. This scope stays fixed between preparation
and confirmation, and the API checks access again when executing the action.
Earlier proposals without a saved organization require a new proposal.

The confirmation card restores the proposal's saved status when a conversation
opens. If a confirmation or cancellation response is interrupted, the card
checks the saved status before offering another attempt. **Check status** reads
the result of the original request, including a result saved after the
connection was interrupted.

The employee editor has two explicit modes. **Text only** processes the supplied
text and employee instructions without workspace collections, documents, MCP
tools, employee knowledge-file retrieval, or workspace business guidance. The
employee's model and custom instructions remain available. An empty
`allowedCollections` list represents this mode. The editor hides the collection
and knowledge-file tabs and saves that empty list. Chat clients can also request
`responseMode: "text"` for a single-step response with no tools, including when
the selected employee has workspace access. That request keeps trusted attached
context and the credential-safety rule while using task-result-only prompt
handling.

**Workspace tools** enables access to workspace capabilities. Its collection
allowlist is checked in addition to tenant ownership; choose one or more
collections or explicitly enable all collections. Switching from text-only mode
starts with no workspace grants, and the editor asks for an explicit scope before
saving. Employees cannot grant access to another tenant's collections.

Knowledge files show as indexed once Savia has saved searchable text. Empty
text or an indexing error puts the file in the failed state. Employee responses
use only indexed files and look up relevant passages by keyword in Savia's
database. Document lookup does not require an embedding provider.

Savia rejects malformed multipart forms and invalid JSON upload fields or
Base64 content before storing a file. For JSON uploads, use a string for
`contentType` and a boolean for `isBase64` when supplying those fields.

If file registration fails after storage, Savia checks for the saved record.
It resumes indexing when the record is present and attempts to remove the
stored object when the record is absent. If the check fails, Savia preserves
the object to avoid losing a document that may already have been registered.

Existing employees with a nonempty collection allowlist remain in Workspace tools
mode with their current scope when edited. A Spanish-to-English translator
template in employee management opens a text-only draft with an active status,
the default model, and three translation styles. Review and save it through the
normal creation form; selecting the template never overwrites an existing
employee. Pages lets the reader choose which labeled translation style to show;
its preview shows all three translations under the exact numbered headings.
Replace, insert, and copy use only the selected version and remove its heading.
If the `traductor` handle is unused, Pages can create the employee and select it
for the request.

Invoking an unknown, inactive, or out-of-scope employee ID returns an
unavailable/not-found result without substituting another employee.

An assistant chat can return HTTP 200 and then fail inside its response stream.
In Workers Logs, look up the request by Ray ID and use its trace ID to find the
`assistant_openrouter_stream_error` event. The event records the upstream HTTP
status when available and omits message bodies and credentials.

See [Remote MCP](../remote-mcp.md) for connecting external clients and the
employee discovery and invocation tools.

Only platform administrators and administrators of the employee's organization
can assign an explicit model when creating an employee or change or clear its
model assignment when editing it. Other users
can keep the inherited model and choose administrator-enabled alternatives in
Pages **Ask AI**. Enabling alternatives does not change the employee's default.

Employee management lists each employee as a full-width row showing the name,
@handle, status, role, access scope, knowledge-file count, and model. Selecting
a row (or its Edit action) opens the create/edit form in a right-side drawer
while the list stays visible behind it. The drawer keeps its header and
save/cancel footer fixed while the form scrolls independently. On narrow
screens each row stacks into sub-rows for identity, description, metadata, and
actions instead of squeezing everything into one horizontal line.

On small screens, the drawer keeps its title and save/cancel actions
visible while the form scrolls independently. Tabs wrap into complete rows
without covering fields; all access modes and sections remain available.

## Publishing an employee to WhatsApp

Use the WhatsApp integration's task-routing settings to publish existing active
employees. Choose a task label that describes the user's goal, audience and
order. Customers see these labels rather than employee names; employee replies
identify the responder. An unpublished or inactive employee is unavailable.

The server intersects the employee's collection grants with channel capabilities
and the caller's current permissions. Staff numbers must be registered separately
from the pilot admission allowlist. Linked staff use their own Savia identity and
personal connections; customers use restricted, contact-owned operations.
Publishing an employee does not grant new collections or personal accounts.

Users can send `menú` or `inicio` at any time to choose another task. Pending
approvals are cancelled; already confirmed jobs retain their original employee.
Writes require a server-generated preview and explicit confirmation. See the
[WhatsApp operations guide](../runbooks/nango-whatsapp.md#task-menu-and-virtual-employee-channel)
for setup, supported commands, cleanup and uncertain-result recovery.
