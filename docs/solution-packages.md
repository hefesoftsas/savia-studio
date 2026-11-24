# Paquetes de soluciones

Savia distingue el motor low code de la configuración sectorial. Este diseño
se inspira en los [plugins de NocoBase](https://docs.nocobase.com/plugin-development/server/)
y sus [migraciones versionadas](https://docs.nocobase.com/plugin-development/server/migration).
El formato JSON de Savia es propio; no ejecuta ni importa paquetes npm de NocoBase.

## Instalar

1. Abre **Administrar páginas** y selecciona la organización o dominio destino.
2. Expande **Paquetes de soluciones**.
3. Descarga una configuración del catálogo o importa un archivo JSON de hasta 2 MB.
4. Revisa los objetos que se crearán o actualizarán y resuelve los conflictos.
5. Pulsa **Instalar paquete**. Las colecciones quedan disponibles en el diseñador.

Solo los administradores del espacio pueden gestionar sus paquetes. La API
deriva el espacio de la ruta autorizada, nunca de un identificador enviado
dentro del archivo. Una instalación no concede permisos sobre otro espacio.

**Descargar** obtiene la plantilla publicada del catálogo. **Exportar instalado**
obtiene el manifiesto con el que se instaló ese paquete, sin registros ni
credenciales; no captura las personalizaciones posteriores del diseñador.

## Formato para otras industrias

```json
{
  "format": "savia.solution",
  "formatVersion": 1,
  "id": "example.inventory",
  "version": "1.0.0",
  "label": "Inventario",
  "description": "Productos del almacén",
  "requires": [],
  "objects": [
    {
      "name": "productos",
      "label": "Productos",
      "description": "",
      "config": {
        "version": 2,
        "fields": {
          "name": { "type": "Textbox", "label": "Nombre", "required": true }
        },
        "fieldOrder": ["name"]
      }
    }
  ]
}
```

Los objetos utilizan el contrato existente del diseñador: campos, relaciones
por `config.relation`, secciones, distribución y opciones de pantalla. Se
pueden crear relaciones mutuas en una misma instalación. `requires` enumera
extensiones disponibles en el despliegue o paquetes activos del mismo espacio.
El instalador valida identificadores, versiones, relaciones y colisiones.

Un paquete declarativo no puede definir capacidades privilegiadas,
`studio.collection`, `studio.business` ni scripts de campos HTML. Los
adaptadores con código se registran en el despliegue. Los flujos externos,
sus conexiones y secretos se configuran por separado; este formato no exporta
automatizaciones guardadas ni servicios externos completos.

## Etiquetas localizadas (ES/EN/PT)

El paquete, sus objetos y sus campos aceptan traducciones opcionales sin
migración de datos:

```json
{
  "label": "Inventario",
  "labels": { "en": "Inventory", "pt": "Inventario" },
  "description": "Productos en almacén.",
  "descriptions": { "en": "Products in stock." },
  "objects": [
    {
      "name": "productos",
      "label": "Productos",
      "labels": { "en": "Products", "pt": "Productos" },
      "config": {
        "fields": {
          "name": {
            "type": "Textbox",
            "label": "Nombre",
            "labels": { "en": "Name", "pt": "Nome" }
          }
        }
      }
    }
  ]
}
```

Las claves ausentes o vacías usan el valor predeterminado en español; los
nombres de objeto, valores de opción y registros guardados nunca cambian.
La interfaz resuelve estas etiquetas según el idioma seleccionado al mostrar
el catálogo y la vista previa, que conserva los valores estables. Una
actualización que modifique campos existentes (incluidas sus etiquetas)
sigue la política habitual: requiere una migración específica en lugar de
sobrescribir personalizaciones.

## Extensiones TypeScript confiables

Una extensión con código usa un manifiesto `savia.extension` versionado, pero
su módulo TypeScript se incluye en el release de Savia y pasa por revisión y
pruebas antes de desplegarse. Un administrador no puede subir ni ejecutar
JavaScript, TypeScript o un `.tgz` desde un paquete de solución.

El catálogo compilado contiene las extensiones disponibles para esa versión de
Savia. La API permite consultar su estado, instalar una extensión incluida en
el catálogo y activarla o desactivarla por tenant:

- `GET /v1/studio/:tenantId/api/extensions`
- `POST /v1/studio/:tenantId/api/extensions/:id/install`
- `PATCH /v1/studio/:tenantId/api/extensions/:id` con `{ "enabled": true | false }`

El host resuelve el tenant desde la ruta autorizada; el manifiesto no puede
seleccionar otro tenant. Una dependencia de `requires` solo se satisface si la
extensión es built-in del release o está activa en ese mismo tenant. Tampoco se
puede desactivar una extensión requerida por otra extensión o solución activa.
La instalación y desactivación conservan datos: este primer incremento no
ejecuta hooks ni migraciones arbitrarias de extensiones.

### Acceso desde el asistente y a colecciones

Las extensiones que quieren colaborar con Savia Assistant registran herramientas
MCP estáticas en el release bajo `savia_extension_`. El asistente solo entrega
al modelo las que tengan `annotations.readOnlyHint: true`; una herramienta de
extensión que escriba no es model-callable. Cualquier escritura sigue pasando
por `savia_prepare_command` y la confirmación explícita del usuario.

El handler de una extensión no recibe `Env`, D1, secretos, cabeceras ni un
selector de tenant. Recibe un cliente de API ligado a la autorización delegada
del usuario, comprueba que su extensión esté activa y luego usa las operaciones
de colecciones autorizadas por el host.

No se implementó carga dinámica de módulos ni subida de `.tgz`. Si se necesita
ejecutar código de terceros, requerirá un producto posterior con artefactos
firmados, CI y un sandbox de capacidades separado del Worker principal.

## Ciclo de vida y actualizaciones

El manifiesto y la propiedad de cada objeto se guardan en D1. La instalación
es un lote atómico con controles de concurrencia; repetir la misma versión y
contenido no duplica objetos. Reutilizar una versión con contenido distinto
se rechaza. Tampoco se permiten retrocesos de versión.

Las actualizaciones admiten objetos nuevos y campos nuevos opcionales sin
unicidad. No eliminan objetos, no cambian campos existentes y no sobrescriben
personalizaciones detectadas. Los cambios incompatibles requieren una
migración específica mediante el mecanismo de esquemas de la plataforma;
no se ejecutan scripts de migración subidos en un paquete.

Desactivar mantiene los datos y el historial y retira las pantallas, el
acceso a sus registros y su API publicada. No se puede desactivar un paquete
del que dependa otro activo. Reactivar restaura la disponibilidad. No hay
desinstalación destructiva ni borrado automático de registros.

## Desarrollo

- Contrato: `packages/studio-shared/src/solution-package.ts`.
- Contrato y registro de extensiones: `packages/studio-shared/src/extension-package.ts`.
- API de colecciones para pantallas de extensiones:
  `packages/studio-shared/src/plugin-api.ts`.
- Instalador y estado: `packages/studio-server/src/solutions.ts` y `solution-state.ts`.
- Estado de extensiones por tenant: `packages/studio-server/src/extensions.ts` y
  `packages/db/migrations/0045_extensions.sql`.
- Conexiones y ejecuciones de extensiones: `packages/studio-server/src/extension-connections.ts`,
  `packages/studio-server/src/extension-actions.ts` y
  `packages/db/migrations/0047_extension_runtime.sql`.
- Requisitos y provisión segura de colecciones:
  `packages/studio-server/src/extension-object-requirements.ts`.
- Resúmenes limitados por el host: `packages/studio-server/src/extension-summaries.ts`.
- Extensiones del API: `apps/api/src/extensions`.
- Herramientas de extensiones para Assistant: `apps/mcp/src/extensions`.
- Catálogo first-party: `packages/release-catalog/`; es el único ensamblador
  que conoce los paquetes sectoriales.
- UI de instalación: `apps/admin/src/features/studio-engine/extension-manager.tsx`.
- Registro de pantallas React: `apps/admin/src/features/studio-engine/extension-screens.tsx`.
- Catálogo compilado: `apps/api/src/solutions/catalog.ts`.

Hosted solution manifests are maintained with the first-party plugins. See the
[hosted release procedure](runbooks/public-repository-operations.md).
`pnpm dev` aplica la migración local; el despliegue debe aplicar las migraciones
D1 antes de servir la nueva versión del API.

Las rutas se ofrecen bajo `/v1/studio/:tenantId/api/solutions` (alias heredado `/v1/dynamic-crm/...`) o
`/v1/studio/:tenantId/api/solutions`: GET catálogo, POST `/preview`,
POST `/install`, GET `/:id/export` y PATCH `/:id` con `{ "enabled": false }`.
