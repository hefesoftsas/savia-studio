import { describe, expect, it } from "vitest";
import { createPublicQuoteAdapter } from "../src/public-forms/quote-adapter";

describe("optional public form integrations", () => {
  it("reports an unavailable integration before reading published industry data", async () => {
    const adapter = createPublicQuoteAdapter({});
    const input = {
      db: undefined as never,
      tenant: "tenant:1",
      tenantId: 1,
      objectName: "example_form",
      snapshot: {},
    };

    await expect(adapter.assertAvailable?.(input)).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      adapter.presentation?.({
        objectName: input.objectName,
        snapshot: input.snapshot,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
