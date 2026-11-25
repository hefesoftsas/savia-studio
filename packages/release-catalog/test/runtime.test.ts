import { describe, expect, it } from "vitest";
import { createPublicQuoteExecutor, publicQuoteContribution } from "../src/public-forms";
import { runtimeReleaseCatalog } from "../src/runtime";
import { assistantQuoteInputSchema } from "../src/assistant-contracts";
import { whatsappIntakeContributions } from "../src/whatsapp";
import { SaviaApiClient } from "../src/assistant-api-client";

describe("runtime release catalog", () => {
  it("ships no compiled contributions after the store migration", () => {
    expect(runtimeReleaseCatalog.solutionCatalog).toEqual([]);
    expect(runtimeReleaseCatalog.connectorActions).toEqual([]);
    expect(runtimeReleaseCatalog.createConnectorActions(undefined)).toEqual([]);
    expect(runtimeReleaseCatalog.extensionSummaryProviders).toEqual([]);
    expect(runtimeReleaseCatalog.extensionObjectRequirements).toEqual([]);
    expect(runtimeReleaseCatalog.workflowBundles).toEqual([]);
    expect(runtimeReleaseCatalog.extensionRegistry.ids()).toEqual([]);
    // Assistant tools moved worker-side (apps/mcp): the catalog no
    // longer registers them; the tool name is covered there.
    expect(runtimeReleaseCatalog.assistantExtensions).toEqual([]);
  });

  it("safely ignores solution-install hooks when no industry package is present", async () => {
    await expect(
      runtimeReleaseCatalog.beforeSolutionInstall(undefined)({
        id: "example.tasks",
      } as never),
    ).resolves.toBeUndefined();
  });

  it("returns safe unavailable fallbacks for optional industry integrations", async () => {
    expect(publicQuoteContribution.objectNames).toEqual([]);
    expect(createPublicQuoteExecutor()).toBeUndefined();
    expect(whatsappIntakeContributions).toEqual([]);

    const parsed = assistantQuoteInputSchema.safeParse({ any: "data" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/not included/i);
    }

    await expect(new SaviaApiClient("https://api.example").createServiceQuote({})).rejects.toThrow(/not included/i);
  });
});
