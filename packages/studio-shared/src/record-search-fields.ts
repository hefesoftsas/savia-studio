import type { StudioObject } from "./metadata";

/** An absent result means the requested search scope no longer has a field. */
export function resolveRecordSearchFields(
  object: StudioObject,
  searchField?: string | null,
  searchFields?: string | null,
): string[] | undefined {
  const requested = searchFields
    ? searchFields.split(",").map((field) => field.trim())
    : searchField
      ? [searchField]
      : [];
  if (!requested.length) return [];
  const fields = requested
    .filter((field) => Object.hasOwn(object.config.fields, field))
    .slice(0, 20);
  return fields.length ? fields : undefined;
}
