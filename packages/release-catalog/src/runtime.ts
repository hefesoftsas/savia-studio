import {
  createExtensionRegistry,
  type ExtensionObjectRequirement,
  type ExtensionRegistry,
} from "@savia/studio-shared/extension-package";
import type { ExtensionActionContext } from "@savia/studio-shared/extension-runtime";
import type { SolutionPackage } from "@savia/studio-shared/solution-package";
import type { SaviaRequestService } from "@savia/studio-shared/savia-request-quotes";
import type { WorkflowBundle } from "@savia/studio-shared/workflow-bundles";

export type AssistantExtensionContribution = {
  id: string;
  register(input: any): void;
};

export type ExtensionSummaryContribution = {
  id: string;
  objectName: string;
  summarize(records: readonly Record<string, unknown>[], asOf: string): unknown;
};

export type ConnectorActionContribution = {
  extensionId: string;
  actionId: string;
  execute(input: {
    context: ExtensionActionContext;
    connection: Record<string, unknown>;
    input: Record<string, unknown>;
  }): Promise<unknown>;
};

export type RuntimeReleaseCatalog = {
  workflowBundles: readonly WorkflowBundle[];
  solutionCatalog: readonly SolutionPackage[];
  extensionRegistry: ExtensionRegistry;
  extensionSummaryProviders: readonly ExtensionSummaryContribution[];
  extensionObjectRequirements: readonly ExtensionObjectRequirement[];
  assistantExtensions: readonly AssistantExtensionContribution[];
  connectorActions: readonly ConnectorActionContribution[];
  createConnectorActions(
    service: SaviaRequestService | undefined,
    options?: { allowedOrigins?: readonly string[] },
  ): readonly ConnectorActionContribution[];
  beforeSolutionInstall(
    service: SaviaRequestService | undefined,
  ): (manifest: SolutionPackage) => Promise<void>;
};

/**
 * Public Savia ships the generic extension and solution hosts. Product
 * contributions are supplied by the release that includes them; the public
 * platform has none to register or install by default.
 */
export const runtimeReleaseCatalog: RuntimeReleaseCatalog = {
  solutionCatalog: [],
  workflowBundles: [],
  extensionRegistry: createExtensionRegistry([]),
  extensionSummaryProviders: [],
  extensionObjectRequirements: [],
  assistantExtensions: [],
  connectorActions: [],
  createConnectorActions: () => [],
  beforeSolutionInstall: () => async () => undefined,
};
