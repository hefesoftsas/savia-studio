import { z } from "zod";
import type { SaviaRequestService } from "@savia/studio-shared/savia-request-quotes";
import type { ExtensionSettingsDefinition } from "@savia/studio-shared/extension-runtime";

const unavailableMessage =
  "This capability is not included in this Savia release.";

type PublicQuoteProduct = {
  id: string;
  label: string;
  enabled: boolean;
  rank: number;
};
type PublicQuoteResult = { premiumTotal?: number };

/** Empty, typed contribution keeps the generic public-form host optional. */
export const publicQuoteContribution = {
  extensionId: "optional-public-form",
  actionId: "unavailable",
  mode: "unavailable",
  connectionId: "unavailable",
  objectNames: [] as readonly string[],
  settingsDefinition: {
    extensionId: "optional-public-form",
    schema: z.record(z.string(), z.unknown()),
    defaults: {},
  } satisfies ExtensionSettingsDefinition,
  fields: [] as {
    name: string;
    label: string;
    type: "text" | "number" | "email" | "date" | "boolean" | "select";
    required: boolean;
    options?: { value: string; label: string }[];
  }[],
  products: [] as PublicQuoteProduct[],
  reference: (submissionId: string) => submissionId,
  readSettings: (_value: unknown, _objectName: string) => ({
    enabled: false,
    products: [] as PublicQuoteProduct[],
  }),
  readVehicleLookup: (_value: unknown) => ({ enabled: false, flowId: "" }),
  validateValues: (_values: Record<string, unknown>): Record<string, unknown> => {
    throw new Error(unavailableMessage);
  },
  actionInput: (
    _flowId: string,
    _values: Record<string, unknown>,
  ): Record<string, unknown> => {
    throw new Error(unavailableMessage);
  },
  projectResult: (_flowId: string, _output: unknown): PublicQuoteResult => {
    throw new Error(unavailableMessage);
  },
  projectHistoryResult: (_flowId: string, _output: unknown) => undefined,
} as const;

/** The public release cannot execute optional product actions. */
export function createPublicQuoteExecutor(
  _service?: SaviaRequestService,
): undefined {
  return undefined;
}
