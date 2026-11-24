import type { PublicQuoteFact } from "@savia/studio-shared/public-quote";

export type ServiceAssistantPorts = {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  resolveStudioTenantId(): Promise<number>;
  listStudioCollectionsForTenant(
    tenantId: number,
    options: { all: boolean },
  ): Promise<{ data: Array<Record<string, unknown>> }>;
  studioPath(tenantId: number, path: string): string;
};

export type ServiceQuoteProgress = {
  productId: string;
  provider: string;
  product: string;
  premium?: number;
  quoteNumber?: string;
  state: "priced" | "unpriced" | "failed" | "uncertain";
  reference: string;
  quoteId: string;
  facts?: PublicQuoteFact[];
};

export type ServiceExecutionOptions = {
  executionKey?: string;
  expectedProductIds?: readonly string[];
  onProgress?(progress: ServiceQuoteProgress): Promise<void> | void;
  linkOwnership?(quoteId: string): Promise<void>;
  claimDispatch?(productId: string): Promise<boolean>;
  executionTimeouts?: {
    requestMs?: number;
    providerMs?: number;
    budgetMs?: number;
  };
};

export type ServiceQuoteForm = {
  products: Array<{ id: string; label: string }>;
  groups?: readonly { name?: unknown; fields?: Record<string, unknown> }[];
  instructions?: unknown;
};

const unavailableMessage =
  "This capability is not included in this Savia release.";

function unavailable(): Error {
  const error = new Error(unavailableMessage);
  error.name = "OptionalCapabilityUnavailableError";
  return error;
}

/** Compatible fallback for optional assistant operations in the public build. */
export class ServiceAssistantOperations {
  constructor(_ports: ServiceAssistantPorts) {}

  async lookupQuoteVehicle(
    _plate: string,
  ): Promise<{ source: string; vehicle: Record<string, unknown> }> {
    throw unavailable();
  }

  async getServiceQuoteForm(): Promise<ServiceQuoteForm> {
    throw unavailable();
  }

  async createServiceQuote(
    _input: unknown,
    _options?: ServiceExecutionOptions,
  ): Promise<never> {
    throw unavailable();
  }

  async getQuoteSummary(_reference?: string): Promise<never> {
    throw unavailable();
  }
}
