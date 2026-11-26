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

When a linked collection omits its total, the list marks the current page and
shows the range of records returned on that page. The source's pagination
metadata determines whether the next page is available.
An empty page with a continuation keeps the current position and allows the
user to advance. The tracked `ra-core` patch prevents the list controller from
resetting to page one in that case.

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
If HubSpot rate-limits listing, summaries, or exports, Savia reports the
rate limit and keeps the provider's HTTP 429 status. When HubSpot includes
`Retry-After`, the API and Studio transport preserve that header.
Studio shows the earliest retry time in the records table and CSV export errors
when that header provides a valid future deadline.
Studio reports a download error if the response contains no CSV, including
when a sign-in page is returned instead of the file.
Studio gives the CSV response body 15 seconds to finish and reports a timeout
instead of saving a partial file.
If the server sends an error status and the explanation stalls, Studio keeps
the original status and reports the failed download.
The export action stays disabled while a download is in progress and becomes
available again when the download finishes or fails.
When the search text changes, Studio applies it to the table before enabling
the export. Both requests use the same search text.
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
HubSpot collection when its summary is available. Unopened HubSpot collections
omit the count.
The Mi día summary widget reports a HubSpot rate limit and keeps the last
verified total visible during that error, if available.
When HubSpot provides a retry deadline, the widget shows it and skips live
refresh events until the deadline passes. The manual retry action stays available.
For other connected collections, Studio and Mi día omit catalog count badges
because those counts describe Savia's local records. Use the record list for a
provider-reported total where available.
Record lists and summaries reject malformed pages and repeated cursors, so an
invalid provider response cannot appear as an empty collection or an exact
count. Search retains the provider's reported total when the requested page
is beyond the last available cursor.

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
