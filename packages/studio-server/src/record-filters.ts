import { z } from "zod";
import { fail } from "./context";

export const filterSchema = z.object({
  logic: z.enum(["and", "or"]).default("and"),
  conditions: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum([
          "eq",
          "ne",
          "gt",
          "gte",
          "lt",
          "lte",
          "contains",
          "startsWith",
          "endsWith",
          "empty",
          "in",
        ]),
        value: z.unknown().optional(),
      }),
    )
    .max(20),
});

export function parseRecordFilters(raw: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return fail("Filtros inválidos.", 422);
  }
  return filterSchema.parse(decoded);
}
