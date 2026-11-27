# 01 — Product (30 min)

Savia is a general-purpose low-code platform, deployed on Cloudflare
Workers + D1/R2. Workspaces organize collections, screens, integrations,
and workflows. Industry-specific capabilities are installed as optional solution packages.

## Actors

- **Workspace user**: works with records, screens and assigned activities.
- **Workspace administrator**: configures collections and workflows within an authorized space.
- **Platform administrator**: operates across workspaces, configures domains,
  integrations, and provider credentials.

## Pieces the user sees

1. **Admin web** (`apps/admin`): React Admin panel + low-code designer
   (domains, objects, screens, forms) at `#/studio` (`#/crm` remains as
   a legacy alias).
2. **Quoter (savia-request)**: the advisor requests a quote; every intent and
   offer is persisted before executing against the provider; retries create
   new attempts, they never mutate the previous one.
3. **Assistant**: bar available on authenticated screens; reads data over MCP
   and prepares changes the user explicitly confirms.
4. **External CRM**: generic contacts/companies capabilities and the connected
   CRM workspace. Legacy customer-profile synchronization is retired. “CRM”
   elsewhere in the UI means this integration; the low-code designer itself
   is called **Studio**.
5. **Solution packages**: configuration installable per workspace. See [solution-packages.md](../solution-packages.md).
6. **Workflows**: native record events, manual actions and schedules connected
   to versioned steps; see [workflows.md](../workflows.md). No industry solution
   is required.

The cookie notice reserves space below the scrollable Admin workspace. Once
the user chooses their cookie preferences, the app installation notice can
use the same footer. On public pages, the cookie notice appears above the
content so visitors can reach form controls before choosing their preferences.

## What it does NOT do

Provider templates and credentials are handled by Workers.

Next: [02-architecture.md](02-architecture.md).
