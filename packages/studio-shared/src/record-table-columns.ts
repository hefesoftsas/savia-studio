import type { StudioObject } from "./metadata";

export const CRM_INTEGRATION_COLUMN_KEY = "__crm_integration";

export function hasCrmIntegrationColumn(object: StudioObject): boolean {
  const collection = object.config.studio?.collection;
  return (
    collection?.kind === "crm" ||
    (collection?.sourceId !== undefined &&
      ["hubspot", "salesforce", "zoho", "pipedrive"].includes(
        collection.sourceId,
      )) ||
    object.name.toLowerCase().includes("hubspot") ||
    object.config.studio?.business === "managed-customer"
  );
}

export function orderRecordTableColumns(order: string[], available: string[]) {
  const availableKeys = new Set(available);
  return [
    ...new Set([
      ...order.filter((key) => availableKeys.has(key)),
      ...available,
    ]),
  ];
}
