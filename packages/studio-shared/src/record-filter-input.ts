import { z } from "zod";

const emptyFilters = z.strictObject({
  logic: z.enum(["and", "or"]).optional(),
  conditions: z.tuple([]),
});

/** Invalid filters still count as supplied so reads cannot silently ignore them. */
export function hasRecordFilters(input: unknown): boolean {
  if (input === undefined || input === "") return false;
  let filters = input;
  if (typeof input === "string") {
    try {
      filters = JSON.parse(input);
    } catch {
      return true;
    }
  }
  return Array.isArray(filters)
    ? filters.length > 0
    : !emptyFilters.safeParse(filters).success;
}
