# Fuentes y colecciones

## Arquitectura

El dominio agrupa pantallas y sus colecciones. La fuente describe cómo acceder a los datos. Una colección conectada declara campos y operaciones; el gateway selecciona su adaptador en el servidor. Las colecciones del registro de dominios existente se pueden conectar inicialmente para consulta. JSON:API permite operaciones remotas explícitamente habilitadas.

Los registros configurables locales siguen usando D1. Una colección conectada no copia automáticamente los datos del origen, ni agrega columnas a bases externas. Los campos del origen se describen para renderizar el formulario; no se crean propiedades externas mediante el diseñador. No hay sincronización bidireccional implícita. HubSpot sigue disponible mediante las capacidades genéricas del espacio de trabajo CRM.

## Diseño de referencia y procedencia

Implementación original de Savia. No se importó, copió ni añadió una dependencia de NocoBase. Se consultaron sus conceptos documentados de DataSource, Collection y Repository:

- https://docs.nocobase.com/data-sources/data-source-manager/
- https://docs.nocobase.com/data-sources/data-source-rest-api/
- https://docs.nocobase.com/data-sources/external/

Al revisar el origen el 2026-09-08, packages/core/data-source-manager/package.json declaraba Apache-2.0, mientras archivos consultados conservaban avisos AGPL/comerciales y LICENSE.txt incluía términos suplementarios. Por la restricción del usuario de reutilizar únicamente código Apache2 inequívoco, no se reutilizó código upstream. Esto registra la decisión técnica de procedencia, sin asumir que todos los archivos de core tienen idéntica licencia.

## Operación

Sources are scoped to the active tenant and the principal that created them. A different tenant cannot list, inspect, update, or delete a source, even when the principal ID matches; within a tenant, source listing and management also enforce creator ownership. Tenant administrators and platform administrators can use source-management routes only within the requested tenant, subject to those ownership checks. Bindings and collection catalogs are tenant-scoped. Credentials remain encrypted in the backend with the integrations key and are never returned in list responses.

Las conexiones JSON:API admiten únicamente destinos públicos HTTPS y recursos configurados, sin redirecciones. Las operaciones no habilitadas se rechazan también desde API. Los errores externos se normalizan sin revelar credenciales. La prueba de conector utiliza transporte controlado; configurar una fuente no envía escrituras.

## Uso y alcance actual

Studio links preserve the selected workspace, collection, and supported view
after sign-in. This includes links to Collection Sources and supported record
links that name both the workspace and collection. A sign-in retry keeps that
destination while the original request is available. Studio verifies workspace
and record access after authentication before showing protected data.

When a linked collection omits its total, the list marks the current page and
shows the range of records returned on that page. The source's pagination
metadata determines whether the next page is available.
For JSON and JSON:API sources, Savia omits a total that falls below the
returned rows or would place an explicit JSON:API next page out of range.
When the source provides a next link, that link determines whether the user can
advance.
An empty page with a continuation shows that only the current page has no
records and directs the user to the next page. When the source reaches the
page limit, the footer indicates that more records exist at the source. The
footer shows zero results for the empty page, even when the collection total
is known. The tracked `ra-core` patch uses the provider's
continuation metadata to keep valid pages accessible. HubSpot row ranges use
the number of records read on previous pages, including after short pages.

Linked collections open in the table view. Older saved pipeline views still
apply their supported table settings, with stage filters omitted.

En CRM, selecciona Plataforma o un dominio independiente y abre Integraciones OpenAPI → Fuentes y colecciones. Se puede vincular una colección del catálogo existente, registrar una fuente JSON:API y declarar sus campos, relaciones y operaciones. El identificador de la pantalla se propone a partir de la colección o recurso y reserva el siguiente sufijo disponible; sigue siendo editable. La administración permite renovar o quitar el token, eliminar fuentes sin vínculos y desvincular pantallas sin borrar registros del origen.

Para una fuente JSON:API, el administrador indica la ruta fija del recurso y puede usar **Analizar recurso** antes de vincularlo. JSON:API no define un catálogo universal de recursos, por lo que la URL base no permite enumerarlos automáticamente. El análisis consulta exactamente una primera página de un registro, devuelve solo campos, relaciones, tipo y metadatos de paginación, y deja ese JSON editable. No devuelve valores de la muestra ni credenciales, no persiste la muestra y conserva los límites de HTTPS público, DNS, redirecciones, 10 segundos y 1 MB del adaptador remoto.

El diseñador de colecciones conectadas permite ordenar y mostrar campos y configurar columnas; no altera el esquema remoto. Para colecciones del catálogo, los campos se infieren de una muestra y el acceso es de consulta. Las colecciones locales conservan el diseñador completo. Otros motores de bases de datos requieren nuevos adaptadores. HubSpot sigue disponible mediante las capacidades genéricas del espacio de trabajo CRM; ya no sincroniza perfiles operativos de clientes.

## Verificación local 2026-09-08

- Migración 0026 aplicada en la copia local de vista previa.
- 60 pruebas API de fuentes, JSON:API, dominios y regresiones de agencias/clientes; 31 pruebas adicionales del servidor CRM independiente.
- 20 pruebas UI de fuentes/detalle/diseñador y 13 de navegación; TypeScript API/administrador sin errores.
- Compilación Vite correcta; advertencia por tamaño de algunos bundles.
- Navegador: colección Contratos vinculada a policy-lifecycle/policies, listado y ficha consultados; diseño de dos columnas guardado y conservado tras recargar.
- Navegador conserva 90 agencias y 50.105 perfiles de clientes. No se realizaron escrituras a proveedores externos; JSON:API se verificó con transporte controlado.

## Reinicio local solicitado

El procedimiento local de vista previa del 2026-09-08 es histórico y depende de tablas y perfiles operativos que ya fueron retirados. No lo uses como una guía de migración. La vinculación de colecciones soportadas, análisis de recursos y configuración de columnas descritos arriba siguen vigentes.

Plataforma ya no instala automáticamente los objetos administrados al abrirse. Los adaptadores anteriores siguen disponibles cuando su metadata está instalada explícitamente. La pantalla inicial permite conectar una colección en un CRM vacío.

## Selective HubSpot screen installation

The HubSpot table's CSV download exports its visible columns and current
free-text search in HubSpot's record order. Saved views only apply settings
supported by the connected source when exporting. Exports can include up to 1,000
matching records. Savia reports a provider error when a page is incomplete
or a record repeats during export, so the user never receives a partial CSV.
If the CSV request is canceled, Savia cancels the active HubSpot request and
stops fetching pages for that export.
If HubSpot rate-limits listing, summaries, or exports, Savia reports the
rate limit and keeps the provider's HTTP 429 status. When HubSpot includes
`Retry-After`, the API and Studio transport preserve that header.
Studio shows the earliest retry time in the records table and CSV export errors
when that header provides a valid future deadline. The affected retry or CSV
download action becomes available at that time. If a table page fails to load,
Studio keeps the requested page selected so Retry can load it in place.
If the HubSpot connection needs to be restored, Studio hides the previous
records and count. Retry the read after reconnecting HubSpot.
Clearing a cached page leaves results from other pages visible. Studio clears
displayed or retained rows when the cache entry that supplied them is cleared.
Studio reports a download error if the response contains no CSV, including
when a sign-in page is returned instead of the file.
Studio gives the CSV response body 15 seconds to finish and reports a timeout
instead of saving a partial file.
If the server sends an error status and the explanation stalls, Studio keeps
the original status and reports the failed download.
The export action stays disabled while a download is in progress and becomes
available again when the download finishes or fails.
Signing out or switching accounts cancels pending Studio downloads, including
downloads that have already started receiving a file.
When the search text changes, Studio applies it to the table before enabling
the export. Both requests use the same search text.
For HubSpot lists, summaries, and CSV exports, an empty filter set is
equivalent to omitting filters. Structured filter conditions return an error.
Search and CSV export accept punctuation in the search text, including percent
signs and ellipses.
Studio only shows the CSV action for Savia tables, domain collections, and
HubSpot. Salesforce, Zoho, Pipedrive, database, JSON:API, and MCP sources
support browsing without CSV export in Studio.
Studio preserves punctuation in supported record IDs when opening, editing,
moving, deleting, or restoring records.
The download uses the visible columns the current user is allowed to export.
Savia tables also preserve the configured column labels and table sort order
for users with scoped export access.
When a named view is saved, Studio stores the search text and the selected
search field for collections that support field-specific searches.
In Savia tables, a search scoped to a field that no longer exists returns a
validation error. Choose an available field or select all fields to search again.
The search selector keeps a saved field visible when its column is hidden and
labels it unavailable if it no longer exists.
Named views reject unknown fields in search, filters, grouping, and sorting
when saved. Views and default table preferences retain the CRM link column
for collections that display it.
Invalid saved-view filters return a validation error in record lists and CSV
exports. Edit or clear the filter before retrying.
Members with read-only access to a shared CRM can browse its records without
an export action.

Studio shows the live record total in the heading and sidebar for the open
HubSpot collection. The records screen uses the verified unfiltered list total
and requests a summary only when the list cannot supply one. After a list rate
limit, Studio waits for an eligible list response before requesting a summary.
Search and saved view filters leave their totals in the table. Unopened
HubSpot collections omit the count.
The Mi día summary widget reports a HubSpot rate limit and keeps the last
verified total visible during that error, if available.
When HubSpot provides a retry deadline, the widget shows it and skips live
refresh events until the deadline passes. The manual retry action stays available.
For other connected collections, Studio and Mi día omit catalog count badges
because those counts describe Savia's local records. Use the record list for a
provider-reported total where available.
Record lists, summaries, and CSV exports reject malformed pages and repeated
cursors. A non-null `paging` value must be an object. Malformed pagination
raises a provider error without supplying a total or producing a partial CSV.
The direct contacts, companies, and deals CRM reads return a provider error
when a successful HubSpot response lacks a valid results array or contains an
invalid record. An empty results array remains a valid response.
A HubSpot record list leaves the total unknown when it matches the
number of scanned records and HubSpot still supplies a next cursor. The
summary follows that cursor before returning a total. When an unfiltered
cursor ends, the list omits totals that exceed the number of scanned records
and the summary reports the inconsistency. Search retains the provider's
reported total when the requested page is beyond the last available cursor.
Studio starts at page one when the search or filters change. It cancels the
previous records request when navigation or a new search replaces it. When
the API proxy receives the cancellation, it stops fetching further pages from
HubSpot.
For sequential HubSpot navigation, Studio can reuse the previous page's
short-lived cursor. The API verifies the same collection, connection, user,
and query before continuing, and retains the scanned count and duplicate
checks. A rate-limited or canceled request, or a temporary upstream failure,
can reuse that cursor within its original lifetime. A request without a
matching live checkpoint scans from the first page.
The assistant's Studio record tool can also pass `nextCursor` as `cursor`
with the next page number and the same collection, query, sort, filters, and
page size. Its reported total stays unknown if the listed rows and the
continuation indicate more records than the supplied total.
The assistant's tools preserve provider error messages and include the retry
time when the API supplies a valid `Retry-After` header for a rate limit.
Each Savia API read has a 15-second deadline that includes consuming the
response body. A timed-out read returns an error to the assistant.

Connected CRM record lists expose at most 100 pages. Salesforce also limits
the starting offset to 2,000 records. Studio and the mail context picker stop
at the supported page limit and indicate when the source has more records.
Any count reported by the provider still describes the full results.
Salesforce, Zoho, and Pipedrive report an upstream error when a record ID is
unusable. Zoho and Pipedrive also reject invalid pagination flags so they
cannot silently truncate record or relationship lists.
Record detail requests also verify that the CRM returned the requested record
before displaying its fields.

In **Sources and collections → Connected CRM · HubSpot**, select the screens you
need and choose **Install selected (N)**. Nothing is selected by default. **Select
all** includes only available screens that are not already installed; **Clear
selection** resets the choice. Unavailable screens show their access reason, and
existing screens show an installed badge. Return to this panel to add more screens
later without reinstalling the existing selection.

Large selections can take longer while Savia reads the HubSpot catalog and
prepares the screens. Studio waits up to 90 seconds for this installation.
If the connection drops, refresh availability before retrying.
If the optional owner lookup is unavailable or returns invalid pagination,
installation keeps the owner ID field available and omits the owner dropdown.

Installation creates the selected Savia screen definitions and connection bindings.
It does not copy all remote records or create, update, or delete records in HubSpot.
Associations to resources with no installed screen do not appear in Savia's related
screen views. Unselecting an installed screen is not an uninstall operation; use
its existing unlink action to remove the screen binding.

The backend validates the explicit resource list and availability before writing
metadata. Unknown, empty, or unavailable selections fail without partially
installing screens. The generated tenant OpenAPI document describes the selection
payload. Legacy callers that omit the selection retain the install-all behavior.

### Removing HubSpot screens and refreshing navigation

Installed HubSpot screens expose **Uninstall** in the same catalog. Confirming
removes the Savia screen and its binding; the HubSpot connection and remote records
remain intact. Cancel leaves the screen installed. Screens with local records or
dependent screen fields cannot be unlinked until those dependencies are resolved.
After uninstalling, the resource can be selected and installed again.

Successful installation clears the cached object catalog before refreshing the
screen list. Installation and removal refresh navigation without waiting for a
full HubSpot availability scan or unrelated queries. The catalog updates installed
badges from the completed operation; **Refresh availability** checks remote access
when needed.

## MCP sources

External read-only MCP tools are supported through the existing manager, with backend OAuth and explicit collection mapping. See [MCP collection sources](../mcp-collection-sources.md) for setup, security boundaries, deployment, and current limits.
