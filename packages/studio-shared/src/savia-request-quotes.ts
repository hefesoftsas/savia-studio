import { z } from "zod";

/**
 * Lógica pura de cotización savia-request, independiente del release.
 * El host la usa para ejecutar acciones `savia-request` del store y el
 * paquete de cotizaciones la reexporta para compatibilidad.
 */

export type ServiceSaviaRequestFlow = {
  id: string;
  label: string;
  role: "internal" | "lookup" | "quote";
  enabledByDefault?: boolean;
};

export const serviceSaviaRequestBundle = {
  id: "example-request-bundle",
  version: "1.1.0",
  flows: [
    { id: "sample-producto-8", label: "SAMPLE · Product 8", role: "quote" },
    { id: "sample-producto-10", label: "SAMPLE · Gold", role: "quote" },
    { id: "sample-producto-11", label: "SAMPLE · Silver", role: "quote" },
    {
      id: "example-lookup-autos-provider",
      label: "Example Lookup",
      role: "lookup",
      enabledByDefault: true,
    },
    { id: "example-alpha-vehicle-by-plate", label: "Example Alpha", role: "lookup" },
    { id: "example-auth-token", label: "Example OAuth", role: "internal" },
  ],
} as const satisfies {
  id: string;
  version: string;
  flows: readonly ServiceSaviaRequestFlow[];
};

export const serviceQuoteFlowCatalog =
  serviceSaviaRequestBundle.flows.filter((flow) => flow.role === "quote");

export const serviceLookupFlowCatalog =
  serviceSaviaRequestBundle.flows.filter((flow) => flow.role === "lookup");

export function isServiceSaviaRequestFlow(flowId: string): boolean {
  return serviceSaviaRequestBundle.flows.some((flow) => flow.id === flowId);
}

export function providerForFlow(flowId: string): string {
  const label = serviceSaviaRequestBundle.flows.find(
    (flow) => flow.id === flowId,
  )?.label;
  return label?.split(" · ")[0] ?? "Proveedor";
}

export type ServiceSampleQuoteInput = {
  vehicle: {
    plate: string;
    referenceCode: string;
    productionYear: number;
    isNew: boolean;
    circulationCity: string;
    accessoriesValue: number;
    declaredValue: number;
  };
  applicant: {
    documentType: string;
    documentNumber: string;
    firstName: string;
    surname: string;
    secondSurname?: string;
    gender: string;
    birthDate: string;
    city: string;
    address: string;
    phone: string;
    email: string;
  };
};

const canonicalQuoteInputFlowIds = new Set([
  "sample-producto-8",
  "sample-producto-10",
  "sample-producto-11",
]);

function normalizedPlate(input: ServiceSampleQuoteInput): string {
  return input.vehicle.plate.trim().toUpperCase();
}

function sampleInput(input: ServiceSampleQuoteInput): Record<string, string> {
  return {
    "sample_request.applicant.address": input.applicant.address,
    "sample_request.applicant.birthDate": input.applicant.birthDate,
    "sample_request.applicant.city": input.applicant.city,
    "sample_request.applicant.documentNumber": input.applicant.documentNumber,
    "sample_request.applicant.documentType": input.applicant.documentType,
    "sample_request.applicant.email": input.applicant.email,
    "sample_request.applicant.firstName": input.applicant.firstName,
    "sample_request.applicant.gender": input.applicant.gender,
    "sample_request.applicant.phone": input.applicant.phone,
    "sample_request.applicant.secondSurname": input.applicant.secondSurname ?? "",
    "sample_request.applicant.surname": input.applicant.surname,
    "sample_request.vehicle.accessoriesValue": String(
      input.vehicle.accessoriesValue,
    ),
    "sample_request.vehicle.circulationCity": input.vehicle.circulationCity,
    "sample_request.vehicle.declaredValue": String(input.vehicle.declaredValue),
    "sample_request.vehicle.referenceCode": input.vehicle.referenceCode,
    "sample_request.vehicle.isNew": String(input.vehicle.isNew),
    "sample_request.vehicle.plate": normalizedPlate(input),
    "sample_request.vehicle.productionYear": String(input.vehicle.productionYear),
  };
}

export function toSaviaRequestInput(
  flowId: string,
  input: ServiceSampleQuoteInput,
): Record<string, string> {
  if (!isServiceSaviaRequestFlow(flowId))
    throw new Error("Flujo del paquete no permitido.");
  if (flowId === "example-lookup-autos-provider")
    return { sample_lookup_test_plate: normalizedPlate(input) };
  if (flowId === "example-alpha-vehicle-by-plate")
    return { sample_alpha_v2_test_plate: normalizedPlate(input) };
  if (canonicalQuoteInputFlowIds.has(flowId)) return sampleInput(input);
  const flow = serviceSaviaRequestBundle.flows.find(
    (candidate) => candidate.id === flowId,
  );
  if (flow?.role === "quote") return {};
  throw new Error(
    "El flujo del paquete no se puede ejecutar desde el cotizador.",
  );
}

const sensitiveField = /(?:api[_-]?key|authorization|password|secret|token)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveField.test(key))
      .map(([key, nested]) => [key, redact(nested)]),
  );
}

export type NormalizedProviderQuote = {
  type: "quote";
  provider: string;
  status: "success";
  data: unknown;
};

export type NormalizedVehicleLookup = {
  type: "vehicle_lookup";
  provider: string;
  status: "success" | "partial";
  data: {
    vehicle: {
      plate: string;
      productionYear?: number;
      referenceCode?: string;
      engineNumber?: string;
      chassisNumber?: string;
      declaredValue?: number;
      accessoriesValue?: number;
      currency: "COP";
    } | null;
  };
};

export type NormalizedServiceAction =
  NormalizedProviderQuote | NormalizedVehicleLookup;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown): number | undefined {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(candidate) ? candidate : undefined;
}

function vehicleFromLookup(
  value: unknown,
): NormalizedVehicleLookup["data"]["vehicle"] {
  const wrapped = record(value);
  const source = record(wrapped?.response) ?? wrapped;
  const plate = text(source?.placa ?? source?.plate);
  if (!plate) return null;
  const productionYear = numeric(source?.modelo ?? source?.modelYear);
  const year =
    productionYear && productionYear >= 1900 && productionYear <= 2200
      ? productionYear
      : undefined;
  return {
    plate: plate.toUpperCase(),
    ...(year === undefined ? {} : { productionYear: year }),
    ...(text(source?.reference) === undefined
      ? {}
      : { referenceCode: text(source?.reference) }),
    ...(text(source?.motor) === undefined
      ? {}
      : { engineNumber: text(source?.motor) }),
    ...(text(source?.chasis) === undefined
      ? {}
      : { chassisNumber: text(source?.chasis) }),
    ...(numeric(source?.valorDeclarado) === undefined
      ? {}
      : { declaredValue: numeric(source?.valorDeclarado) }),
    ...(numeric(source?.valorAccesorios) === undefined
      ? {}
      : { accessoriesValue: numeric(source?.valorAccesorios) }),
    currency: "COP",
  };
}

export function normalizeProviderQuote(
  provider: string,
  response: unknown,
): NormalizedProviderQuote {
  return {
    type: "quote",
    provider,
    status: "success",
    data: redact(response),
  };
}

export function normalizeServiceAction(
  provider: string,
  operationId: string,
  response: unknown,
): NormalizedServiceAction {
  if (
    operationId === "example-lookup-vehicle-by-plate" ||
    operationId === "example-lookup-autos-provider"
  ) {
    const vehicle = vehicleFromLookup(response);
    return {
      type: "vehicle_lookup",
      provider,
      status: vehicle ? "success" : "partial",
      data: { vehicle },
    };
  }
  return normalizeProviderQuote(provider, response);
}

const quoteVehicleSchema = z
  .object({
    plate: z.string().trim().min(1),
    referenceCode: z.string().trim().min(1),
    productionYear: z.number().int(),
    isNew: z.boolean(),
    circulationCity: z.string().trim().min(1),
    accessoriesValue: z.number().finite().min(0),
    declaredValue: z.number().finite().positive(),
  })
  .strict();

const quoteApplicantSchema = z
  .object({
    documentType: z.string().trim().min(1),
    documentNumber: z.string().trim().min(1),
    firstName: z.string().trim().min(1),
    surname: z.string().trim().min(1),
    secondSurname: z.string().trim().min(1).optional(),
    gender: z.string().trim().min(1),
    birthDate: z.string().trim().min(1),
    city: z.string().trim().min(1),
    address: z.string().trim().min(1),
    phone: z.string().trim().min(1),
    email: z.string().trim().min(1),
  })
  .strict();

export const quoteInputSchema = z
  .object({ vehicle: quoteVehicleSchema, applicant: quoteApplicantSchema })
  .strict();

export const lookupQuoteInputSchema = z
  .object({
    vehicle: z.object({ plate: z.string().trim().min(1) }).passthrough(),
  })
  .passthrough();

export const saviaRequestActionInputSchema = z
  .object({
    mode: z.enum(["mock", "live"]),
    flowId: z.string().trim().min(1),
    quoteInput: z.unknown(),
  })
  .strict();

export const saviaRequestFlowRunSchema = z
  .object({ status: z.string(), result: z.unknown().nullable() })
  .passthrough();

export type SaviaRequestService = {
  fetch(request: Request): Response | Promise<Response>;
};
