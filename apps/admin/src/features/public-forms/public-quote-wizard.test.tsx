import {
  I18nContextProvider,
  StoreContextProvider,
  memoryStore,
  useSetLocale,
} from "ra-core";
import { AppLocaleProvider } from "@/i18n/app-locale-provider";
import type { ReactElement, ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicQuoteForm } from "./public-quote-wizard";

const quoteDefinition = {
  id: "quote-form-id",
  title: "Cotizador por pasos",
  kind: "quote" as const,
  captchaProvider: "turnstile" as const,
  siteKey: "site-key",
  presentation: {
    renderer: "provider-quote-wizard" as const,
    entry: "wizard" as const,
    products: Array.from({ length: 19 }, (_, i) => ({
      flowId: `flow-${i}`,
      label: `Provider ${i} · Product ${i}`,
    })),
  },
  fields: [
    {
      name: "vehicle_plate",
      label: "Placa",
      type: "text" as const,
      required: true,
    },
    {
      name: "vehicle_referenceCode",
      label: "Código Reference",
      type: "text" as const,
      required: true,
    },
    {
      name: "vehicle_productionYear",
      label: "Año del vehículo",
      type: "number" as const,
      required: true,
    },
    {
      name: "vehicle_isNew",
      label: "Vehículo nuevo",
      type: "boolean" as const,
      required: false,
    },
    {
      name: "vehicle_circulationCity",
      label: "Código de ciudad de circulación",
      type: "text" as const,
      required: true,
    },
    {
      name: "vehicle_accessoriesValue",
      label: "Valor de accesorios",
      type: "number" as const,
      required: false,
    },
    {
      name: "vehicle_declaredValue",
      label: "Valor declarado",
      type: "number" as const,
      required: true,
    },
    {
      name: "applicant_documentType",
      label: "Tipo de documento",
      type: "select" as const,
      required: true,
      options: [
        { value: "CC", label: "Cédula de ciudadanía" },
        { value: "CE", label: "Cédula de extranjería" },
      ],
    },
    {
      name: "applicant_documentNumber",
      label: "Número de documento",
      type: "text" as const,
      required: true,
    },
    {
      name: "applicant_firstName",
      label: "Nombres",
      type: "text" as const,
      required: true,
    },
    {
      name: "applicant_surname",
      label: "Primer apellido",
      type: "text" as const,
      required: true,
    },
    {
      name: "applicant_secondSurname",
      label: "Segundo apellido",
      type: "text" as const,
      required: false,
    },
    {
      name: "applicant_gender",
      label: "Sexo",
      type: "select" as const,
      required: true,
      options: [
        { value: "F", label: "Femenino" },
        { value: "M", label: "Masculino" },
      ],
    },
    {
      name: "applicant_birthDate",
      label: "Fecha de nacimiento",
      type: "date" as const,
      required: true,
    },
    {
      name: "applicant_city",
      label: "Código de ciudad de residencia",
      type: "text" as const,
      required: true,
    },
    {
      name: "applicant_address",
      label: "Dirección",
      type: "text" as const,
      required: true,
    },
    {
      name: "applicant_phone",
      label: "Teléfono",
      type: "text" as const,
      required: true,
    },
    {
      name: "applicant_email",
      label: "Correo electrónico",
      type: "email" as const,
      required: true,
    },
  ],
};

let widget: Record<string, unknown> | undefined;
const reset = vi.fn();
const remove = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  widget = undefined;
  fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, reference: "quote-receipt-123" }),
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("turnstile", {
    render: vi.fn((_element, options) => {
      widget = options;
      return "widget-id";
    }),
    reset,
    remove,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function render(ui: ReactElement) {
  return testingRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nContextProvider
        value={{
          translate: (key: string) => key,
          changeLocale: async () => {},
          getLocale: () => "es",
        }}
      >
        {children}
      </I18nContextProvider>
    ),
  });
}

async function solve() {
  await waitFor(() => expect(widget?.callback).toBeTypeOf("function"));
  act(() => (widget!.callback as (token: string) => void)("captcha-token"));
}

it("renders the plugin-shaped wizard shell with products and steps", async () => {
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  expect(await screen.findByText("COTIZACIONES")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: /Cotizador por pasos/ }),
  ).toBeInTheDocument();
  expect(screen.getByText("19 productos")).toBeInTheDocument();
  expect(screen.getByText("Vehículo")).toBeInTheDocument();
  expect(screen.getByText("Solicitante y conductor")).toBeInTheDocument();
  expect(screen.getByText("Contacto y cotización")).toBeInTheDocument();
  // First step fields from the quote definition.
  expect(screen.getByLabelText(/Placa/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Correo electrónico/)).not.toBeInTheDocument();
  // No private admin capabilities.
  expect(screen.queryByText("Cotizaciones")).not.toBeInTheDocument();
  expect(screen.queryByText("Historial")).not.toBeInTheDocument();
  expect(screen.queryByText(/CRM/)).not.toBeInTheDocument();
});

it("advances on implicit form submission without sending the quote", async () => {
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  // Try to advance without filling required fields: browser validation blocks.
  const next = screen.getByRole("button", { name: /Siguiente paso/ });
  const form = next.closest("form")!;
  fireEvent.click(next);
  expect(screen.getByLabelText(/Placa/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/Placa/), {
    target: { value: "TESTCAR" },
  });
  fireEvent.change(screen.getByLabelText(/Código Reference/), {
    target: { value: "12345678" },
  });
  fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
    target: { value: "2023" },
  });
  fireEvent.change(screen.getByLabelText(/Código de ciudad de circulación/), {
    target: { value: "11001" },
  });
  fireEvent.change(screen.getByLabelText(/Valor declarado/), {
    target: { value: "50000000" },
  });

  fireEvent.submit(form);
  expect(
    await screen.findByLabelText(/Número de documento/),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText(/Placa/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Revisa el campo/)).not.toBeInTheDocument();
  expect(next).toHaveAttribute("type", "submit");
  expect(fetchMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /Anterior/ }));
  expect(await screen.findByLabelText(/Placa/)).toBeInTheDocument();
});

it.each([
  "submit response",
  "status recovery",
  "status lookup offline",
  "status lookup unavailable",
  "status lookup stalled",
])(
  "keeps CAPTCHA and normalized values at the final step (%s)",
  async (outcome) => {
    let statusReads = 0;
    let stalledSignal: AbortSignal | null | undefined;
    if (outcome === "submit response") {
      fetchMock.mockResolvedValueOnce(
        Response.json({
          ok: true,
          reference: "quote-receipt-123",
          result: {
            quotes: [
              {
                provider: "Provider fixture",
                product: "Vehicle quote",
                premiumTotal: 1234567,
                currency: "COP",
                providerPayload: "PRIVATE TEST PAYLOAD",
              },
              {
                provider: "Unsupported provider",
                product: "Invalid quote",
                premiumTotal: 100,
                currency: "USD",
              },
            ],
            unavailable: 1,
          },
        }),
      );
    } else {
      fetchMock.mockImplementation(async (input, init?: RequestInit) => {
        if (!String(input).includes("/status/"))
          throw new TypeError("Connection lost");
        if (++statusReads === 1) {
          if (outcome === "status lookup offline")
            throw new TypeError("Connection still unavailable");
          if (outcome === "status lookup unavailable")
            return new Response(null, { status: 503 });
          if (outcome === "status lookup stalled") {
            stalledSignal = init?.signal;
            return new Promise<Response>(() => {});
          }
          return Response.json({ items: [] });
        }
        return Response.json({
          state: "complete",
          receipt: { ok: true, reference: "quote-receipt-123", result: null },
        });
      });
    }
    render(
      <PublicQuoteForm
        definition={quoteDefinition}
        endpoint="https://api.test/api/public/forms/quote-token"
      />,
    );
    // Step 1 -> fill vehicle.
    fireEvent.change(await screen.findByLabelText(/Placa/), {
      target: { value: "testcar" },
    });
    fireEvent.change(screen.getByLabelText(/Código Reference/), {
      target: { value: "12345678" },
    });
    fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
      target: { value: "2023" },
    });
    fireEvent.change(screen.getByLabelText(/Código de ciudad de circulación/), {
      target: { value: "11001" },
    });
    fireEvent.change(screen.getByLabelText(/Valor declarado/), {
      target: { value: "50000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));

    // Step 2 -> fill applicant.
    fireEvent.change(await screen.findByLabelText(/Tipo de documento/), {
      target: { value: "CC" },
    });
    fireEvent.change(screen.getByLabelText(/Número de documento/), {
      target: { value: "123456789" },
    });
    fireEvent.change(screen.getByLabelText(/Nombres/), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText(/Primer apellido/), {
      target: { value: "Example" },
    });
    fireEvent.change(screen.getByLabelText(/Sexo/), { target: { value: "F" } });
    fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/), {
      target: { value: "1990-01-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));

    // Final step shows contact fields + CAPTCHA + submit.
    expect(
      await screen.findByLabelText(/Correo electrónico/),
    ).toBeInTheDocument();
    const captchaMount = await screen.findByLabelText(
      /Verificación de seguridad/,
    );
    expect(captchaMount).toBeInTheDocument();
    expect(widget).toMatchObject({
      sitekey: "site-key",
      action: "public_submit",
      cData: "quote-form-id",
    });

    fireEvent.change(screen.getByLabelText(/Código de ciudad de residencia/), {
      target: { value: "11001" },
    });
    fireEvent.change(screen.getByLabelText(/Dirección/), {
      target: { value: "Example 123" },
    });
    fireEvent.change(screen.getByLabelText(/Teléfono/), {
      target: { value: "3001234567" },
    });
    fireEvent.change(screen.getByLabelText(/Correo electrónico/), {
      target: { value: "ada@example.test" },
    });

    const submitButton = screen.getByRole("button", {
      name: /Enviar solicitud|Solicitar cotización|Cotizar/,
    });
    expect(submitButton).toBeDisabled();
    await solve();
    if (outcome === "status lookup stalled") {
      vi.useFakeTimers();
      await act(async () => fireEvent.click(submitButton));
      expect(statusReads).toBe(1);
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(stalledSignal?.aborted).toBe(true);
      vi.useRealTimers();
    } else {
      fireEvent.click(submitButton);
    }

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => !String(url).includes("/status/"),
        ),
      ).toHaveLength(1),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url]) => !String(url).includes("/status/"),
    )!;
    expect(init.credentials).toBe("omit");
    const payload = JSON.parse(init.body);
    expect(payload.values.vehicle_plate).toBe("TESTCAR");
    expect(payload.values.applicant_email).toBe("ada@example.test");
    expect(payload.values).not.toHaveProperty("flowId");
    expect(payload.values).not.toHaveProperty("actionId");
    expect(JSON.stringify(payload)).not.toMatch(/provider|secret|credential/i);
    expect(
      await screen.findByRole(
        "heading",
        { name: "Solicitud recibida" },
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("quote-receipt-123")).toBeInTheDocument();
    if (outcome === "submit response") {
      expect(screen.getByText("Provider fixture")).toBeVisible();
      expect(screen.getByText("Vehicle quote")).toBeVisible();
      expect(screen.getByText(/1\.234\.567/)).toBeVisible();
      expect(
        screen.getByText("2 resultados no están disponibles."),
      ).toBeVisible();
      expect(
        screen.queryByText("Unsupported provider"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("PRIVATE TEST PAYLOAD"),
      ).not.toBeInTheDocument();
    }
    const print = vi.fn();
    Object.defineProperty(window, "print", {
      configurable: true,
      value: print,
    });
    fireEvent.click(screen.getByRole("button", { name: "Descargar PDF" }));
    expect(print).toHaveBeenCalledTimes(1);
    if (outcome !== "submit response") {
      const statuses = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/status/"),
      );
      expect(statuses.map(([url]) => String(url))).toEqual(
        Array(2).fill(
          `https://api.test/api/public/forms/quote-token/status/${payload.submissionId}`,
        ),
      );
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => !String(url).includes("/status/"),
        ),
      ).toHaveLength(1);
    }
  },
);

it("allows manual vehicle entry and a fresh lookup after a stalled response", async () => {
  fetchMock.mockImplementationOnce(async () => new Promise<Response>(() => {}));
  fetchMock.mockResolvedValueOnce(
    Response.json({
      plate: "TESTCAR",
      referenceCode: "12345678",
      productionYear: 2023,
    }),
  );
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  const plate = await screen.findByLabelText(/Placa/);
  fireEvent.change(plate, { target: { value: "TESTCAR" } });
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Consultar placa" }));
  expect(plate).toBeDisabled();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
  expect(screen.getByText("No se pudo consultar la placa.")).toBeVisible();
  expect(plate).toBeEnabled();
  expect(plate).toHaveValue("TESTCAR");
  fireEvent.blur(plate);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText(/Código Reference/)).toBeEnabled();
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "Consultar placa" }));
  await screen.findAllByText("✓ Autocompletado");
  expect(screen.getByLabelText(/Código Reference/)).toHaveValue("12345678");
});

it("looks up the plate and autofills vehicle fields like the embedded wizard", async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        plate: "TESTCAR",
        referenceCode: "12345678",
        productionYear: 2023,
        declaredValue: 50000000,
      }),
    ),
  );
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  fireEvent.change(await screen.findByLabelText(/Placa/), {
    target: { value: "testcar" },
  });
  // The typed plate is normalized to uppercase.
  expect(screen.getByLabelText(/Placa/)).toHaveValue("TESTCAR");
  fireEvent.click(screen.getByRole("button", { name: "Consultar placa" }));
  expect(await screen.findAllByText("✓ Autocompletado")).not.toHaveLength(0);
  expect(screen.getByLabelText(/Código Reference/)).toHaveValue("12345678");
  expect(screen.getByLabelText(/Año del vehículo/)).toHaveValue(2023);
  expect(screen.getByLabelText(/Valor declarado/)).toHaveValue("50.000.000");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain("/vehicle-lookup");
  expect(init.credentials).toBe("omit");
  expect(JSON.parse(init.body)).toEqual({ plate: "TESTCAR" });
  fireEvent.change(screen.getByLabelText(/Valor declarado/), {
    target: { value: "53000000" },
  });
  fetchMock.mockResolvedValueOnce(
    Response.json({
      plate: "TESTCAR",
      referenceCode: "87654321",
      declaredValue: 50000000,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Consultar placa" }));
  await screen.findByDisplayValue("87654321");
  expect(screen.getByLabelText(/Valor declarado/)).toHaveValue("53.000.000");
  expect(screen.getByLabelText(/Año del vehículo/)).toHaveValue(2023);

  // Even data omitted by the second lookup remains associated with the plate.
  fireEvent.change(screen.getByLabelText(/Placa/), {
    target: { value: "DEMOCAR" },
  });
  expect(screen.getByLabelText(/Código Reference/)).toHaveValue("");
  expect(screen.getByLabelText(/Año del vehículo/)).toHaveValue(null);
  expect(screen.getByLabelText(/Valor declarado/)).toHaveValue("53.000.000");
  expect(screen.queryByText("✓ Autocompletado")).not.toBeInTheDocument();
});

it("auto-triggers the lookup on blur and reports an empty result", async () => {
  fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  fireEvent.change(await screen.findByLabelText(/Placa/), {
    target: { value: "SINCAR" },
  });
  fireEvent.blur(screen.getByLabelText(/Placa/));
  expect(
    await screen.findByText("No se encontraron datos para esa placa."),
  ).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("keeps only the latest city suggestions when requests finish out of order", async () => {
  let finishBogota!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishBogota = resolve;
      }),
  );
  fetchMock.mockResolvedValueOnce(
    Response.json({
      matches: [{ code: "76001", city: "Cali", department: "Valle del Cauca" }],
    }),
  );
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  const city = await screen.findByLabelText(/Código de ciudad de circulación/);
  fireEvent.change(city, { target: { value: "bog" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.change(city, { target: { value: "cali" } });
  await screen.findByText("Cali (Valle del Cauca)");
  await act(async () => {
    finishBogota(
      Response.json({
        matches: [{ code: "11001", city: "Bogotá", department: "Bogotá D.C." }],
      }),
    );
  });
  expect(screen.queryByText("Bogotá (Bogotá D.C.)")).not.toBeInTheDocument();
  fireEvent.keyDown(city, { key: "Enter" });
  expect(city).toHaveValue("76001");
});

it("does not reopen city suggestions after focus leaves the city control", async () => {
  let finishSearch!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishSearch = resolve;
      }),
  );
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  const city = await screen.findByLabelText(/Código de ciudad de circulación/);
  act(() => city.focus());
  fireEvent.change(city, { target: { value: "bog" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  act(() => screen.getByLabelText(/Valor declarado/).focus());
  await act(async () => {
    finishSearch(
      Response.json({
        matches: [{ code: "11001", city: "Bogotá", department: "Bogotá D.C." }],
      }),
    );
  });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(city).toHaveAttribute("aria-expanded", "false");
  expect(city).toHaveValue("bog");
});

it("suggests DANE cities and stores the selected code", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({
      matches: [
        { code: "11001", city: "Bogotá", department: "Bogotá D.C.", junk: 1 },
        { code: "05001", city: "Medellín", department: "Antioquia" },
      ],
    }),
  );
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  fireEvent.change(
    await screen.findByLabelText(/Código de ciudad de circulación/),
    {
      target: { value: "bog" },
    },
  );
  expect(await screen.findByText("Bogotá (Bogotá D.C.)")).toBeInTheDocument();
  const city = screen.getByLabelText(/Código de ciudad de circulación/);
  const suggestion = screen.getByRole("button", { name: /Bogotá/ });
  act(() => city.focus());
  act(() => suggestion.focus());
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.click(suggestion);
  expect(city).toHaveFocus();
  expect(screen.getByLabelText(/Código de ciudad de circulación/)).toHaveValue(
    "11001",
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain("/cities?search=bog");
  expect(init.credentials).toBe("omit");
});

it("formats currency fields with thousands separators but submits raw numbers", async () => {
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  const input = await screen.findByLabelText(/Valor declarado/);
  fireEvent.change(input, { target: { value: "50000000" } });
  expect(input).toHaveValue("50.000.000");
  fireEvent.change(input, { target: { value: "50.000.000" } });
  expect(input).toHaveValue("50.000.000");
  fireEvent.input(input, {
    target: { value: "50.000.0000" },
    inputType: "insertText",
    data: "0",
  });
  expect(input).toHaveValue("500.000.000");
  fireEvent.change(input, { target: { value: "1000000000000" } });
  expect(input).toHaveValue("1.000.000.000.000");
});

it("names the failing field instead of showing the generic submit error", async () => {
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  fireEvent.change(await screen.findByLabelText(/Placa/), {
    target: { value: "TESTCAR" },
  });
  fireEvent.change(screen.getByLabelText(/Código Reference/), {
    target: { value: "12345678" },
  });
  fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
    target: { value: "1800" },
  });
  fireEvent.change(screen.getByLabelText(/Código de ciudad de circulación/), {
    target: { value: "11001" },
  });
  fireEvent.change(screen.getByLabelText(/Valor declarado/), {
    target: { value: "50000000" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
  const error = await screen.findByText(/Revisa el campo/);
  expect(error.textContent).toContain("Año del vehículo");
  // Still on the vehicle step, focused on the failing field.
  expect(screen.getByLabelText(/Placa/)).toBeInTheDocument();
  expect(document.activeElement).toBe(
    screen.getByLabelText(/Año del vehículo/),
  );
  expect(fetchMock).not.toHaveBeenCalled();
  // Fixing the year clears its error. Invalid currency must not be silently
  // converted into a different positive amount.
  fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
    target: { value: "2023" },
  });
  expect(screen.queryByText(/Revisa el campo/)).not.toBeInTheDocument();
  const declaredValue = screen.getByLabelText(/Valor declarado/);
  for (const invalid of ["-50000000", "50,25", "50.25"]) {
    fireEvent.change(declaredValue, { target: { value: invalid } });
    fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
    expect(
      await screen.findByText(/Revisa el campo.*Valor declarado/i),
    ).toBeVisible();
    expect(declaredValue).toHaveValue(invalid);
    expect(declaredValue).toHaveFocus();
  }
  fireEvent.change(declaredValue, { target: { value: "50000000" } });
  fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
  expect(
    await screen.findByLabelText(/Número de documento/),
  ).toBeInTheDocument();
});

it.each(["complete", "failed"])(
  "shows provider progress and the %s result without changing tabs or resubmitting",
  async (state) => {
    render(
      <PublicQuoteForm
        definition={quoteDefinition}
        endpoint="https://api.test/api/public/forms/quote-token"
      />,
    );
    fireEvent.change(await screen.findByLabelText(/Placa/), {
      target: { value: "TESTCAR" },
    });
    fireEvent.change(screen.getByLabelText(/Código Reference/), {
      target: { value: "12345678" },
    });
    fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
      target: { value: "2023" },
    });
    fireEvent.change(screen.getByLabelText(/Código de ciudad de circulación/), {
      target: { value: "11001" },
    });
    fireEvent.change(screen.getByLabelText(/Valor declarado/), {
      target: { value: "50000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
    fireEvent.change(await screen.findByLabelText(/Tipo de documento/), {
      target: { value: "CC" },
    });
    fireEvent.change(screen.getByLabelText(/Número de documento/), {
      target: { value: "123456789" },
    });
    fireEvent.change(screen.getByLabelText(/Nombres/), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText(/Primer apellido/), {
      target: { value: "Example" },
    });
    fireEvent.change(screen.getByLabelText(/Sexo/), { target: { value: "F" } });
    fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/), {
      target: { value: "1990-01-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
    fireEvent.change(
      await screen.findByLabelText(/Código de ciudad de residencia/),
      {
        target: { value: "11001" },
      },
    );
    fireEvent.change(screen.getByLabelText(/Dirección/), {
      target: { value: "Example 123" },
    });
    fireEvent.change(screen.getByLabelText(/Teléfono/), {
      target: { value: "3001234567" },
    });
    fireEvent.change(screen.getByLabelText(/Correo electrónico/), {
      target: { value: "ada@example.test" },
    });
    await solve();
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        items: [
          {
            flowId: "fixture",
            label: "Product fixture",
            provider: "Provider fixture",
            status: "quoting",
          },
          {
            flowId: "finished-fixture",
            label: "Finished product",
            provider: "Finished provider",
            status: "done",
            result: { premiumTotal: 1250000, currency: "COP" },
          },
        ],
      }),
    );
    fetchMock.mockResolvedValueOnce(
      Response.json(
        state === "complete"
          ? {
              state,
              receipt: {
                ok: true,
                reference: "background-receipt",
              },
            }
          : { state },
      ),
    );
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/ }));
    });
    expect(screen.getByText(/Cotizando con proveedores/)).toBeInTheDocument();
    expect(screen.getByText(/no cierres ni recargues/)).toBeInTheDocument();
    expect(
      document.querySelectorAll(".public-quote-skeleton-card"),
    ).toHaveLength(3);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText("Provider fixture")).toBeVisible();
    expect(screen.getByText("Product fixture")).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    if (state === "complete") {
      expect(screen.getByText("background-receipt")).toBeVisible();
      expect(screen.getByText("Finished provider")).toBeVisible();
      expect(screen.queryByText("Provider fixture")).not.toBeInTheDocument();
    } else {
      expect(
        screen.getByRole("heading", { name: "Cotización no completada" }),
      ).toBeVisible();
      expect(
        screen.queryByText(/Cotizando con proveedores/),
      ).not.toBeInTheDocument();
      const calls = fetchMock.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  },
);

it("rejects a malformed plate before calling the lookup", async () => {
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  fireEvent.change(await screen.findByLabelText(/Placa/), {
    target: { value: "AB" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Consultar placa" }));
  const error = await screen.findByText(/Revisa el campo/);
  expect(error.textContent).toContain("Placa");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("auto-triggers the lookup on blur for short plates", async () => {
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  fireEvent.change(await screen.findByLabelText(/Placa/), {
    target: { value: "ABC" },
  });
  fireEvent.blur(screen.getByLabelText(/Placa/));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain("/vehicle-lookup");
  expect(JSON.parse(init.body)).toEqual({ plate: "ABC" });
});

it("navigates city suggestions with the arrow keys and selects the highlighted code", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({
      matches: [
        { code: "11001", city: "Bogotá", department: "Bogotá D.C." },
        { code: "05001", city: "Medellín", department: "Antioquia" },
      ],
    }),
  );
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  const input = await screen.findByLabelText(/Código de ciudad de circulación/);
  fireEvent.change(input, { target: { value: "bog" } });
  expect(await screen.findByText("Bogotá (Bogotá D.C.)")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const highlighted = screen.getByRole("option", {
    name: /Medellín/,
    selected: true,
  });
  expect(input).toHaveAttribute("aria-activedescendant", highlighted.id);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByLabelText(/Código de ciudad de circulación/)).toHaveValue(
    "05001",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Limpiar ciudad seleccionada" }),
  );
  expect(screen.getByLabelText(/Código de ciudad de circulación/)).toHaveValue(
    "",
  );
});

it("keeps future unknown fields visible in the final step", async () => {
  const extended = {
    ...quoteDefinition,
    fields: [
      ...quoteDefinition.fields,
      {
        name: "custom_notes",
        label: "Notas adicionales",
        type: "text" as const,
        required: false,
      },
    ],
  };
  render(
    <PublicQuoteForm
      definition={extended}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  fireEvent.change(await screen.findByLabelText(/Placa/), {
    target: { value: "TESTCAR" },
  });
  fireEvent.change(screen.getByLabelText(/Código Reference/), {
    target: { value: "12345678" },
  });
  fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
    target: { value: "2023" },
  });
  fireEvent.change(screen.getByLabelText(/Código de ciudad de circulación/), {
    target: { value: "11001" },
  });
  fireEvent.change(screen.getByLabelText(/Valor declarado/), {
    target: { value: "50000000" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
  fireEvent.change(await screen.findByLabelText(/Tipo de documento/), {
    target: { value: "CC" },
  });
  fireEvent.change(screen.getByLabelText(/Número de documento/), {
    target: { value: "123456789" },
  });
  fireEvent.change(screen.getByLabelText(/Nombres/), {
    target: { value: "Ada" },
  });
  fireEvent.change(screen.getByLabelText(/Primer apellido/), {
    target: { value: "Example" },
  });
  fireEvent.change(screen.getByLabelText(/Sexo/), { target: { value: "F" } });
  fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/), {
    target: { value: "1990-01-01" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
  expect(await screen.findByLabelText(/Notas adicionales/)).toBeInTheDocument();
});

it.each([
  {
    now: "2026-01-10T12:00:00Z",
    birthdayTomorrow: "2010-01-11",
    expected: "1995-06-15",
  },
  {
    now: "2026-07-10T12:00:00Z",
    birthdayTomorrow: "2010-07-11",
    expected: "1996-06-15",
  },
])(
  "uses calendar dates for the age display and presets on $now",
  async ({ now, birthdayTomorrow, expected }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    render(
      <PublicQuoteForm
        definition={quoteDefinition}
        endpoint="https://api.test/api/public/forms/quote-token"
      />,
    );
    fireEvent.change(await screen.findByLabelText(/Placa/), {
      target: { value: "TESTCAR" },
    });
    fireEvent.change(screen.getByLabelText(/Código Reference/), {
      target: { value: "12345678" },
    });
    fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
      target: { value: "2023" },
    });
    fireEvent.change(screen.getByLabelText(/Código de ciudad de circulación/), {
      target: { value: "11001" },
    });
    fireEvent.change(screen.getByLabelText(/Valor declarado/), {
      target: { value: "50000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
    expect(
      await screen.findByRole("group", { name: "Edad:" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/), {
      target: { value: birthdayTomorrow },
    });
    expect(screen.getByText("15 años")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "30" }));
    expect(screen.getByLabelText(/Fecha de nacimiento/)).toHaveValue(expected);
    expect(screen.getByRole("button", { name: "30" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
);

it("shows example placeholders mirroring the embedded wizard", async () => {
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  expect(await screen.findByLabelText(/Placa/)).toHaveAttribute(
    "placeholder",
    "Ej. TESTCAR",
  );
  expect(screen.getByLabelText(/Código Reference/)).toHaveAttribute(
    "placeholder",
    "Ej. 123456",
  );
  expect(screen.getByLabelText(/Año del vehículo/)).toHaveAttribute(
    "placeholder",
    "Ej. 2024",
  );
  expect(
    screen.getByLabelText(/Código de ciudad de circulación/),
  ).toHaveAttribute(
    "placeholder",
    "Buscar ciudad (ej. Bogotá, Medellín, Cali)...",
  );
  expect(screen.getByLabelText(/Valor declarado/)).toHaveAttribute(
    "placeholder",
    "Ej. 50000000",
  );
  fireEvent.change(screen.getByLabelText(/Placa/), {
    target: { value: "TESTCAR" },
  });
  fireEvent.change(screen.getByLabelText(/Código Reference/), {
    target: { value: "12345678" },
  });
  fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
    target: { value: "2023" },
  });
  fireEvent.change(screen.getByLabelText(/Código de ciudad de circulación/), {
    target: { value: "11001" },
  });
  fireEvent.change(screen.getByLabelText(/Valor declarado/), {
    target: { value: "50000000" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
  expect(await screen.findByLabelText(/Número de documento/)).toHaveAttribute(
    "placeholder",
    "Ej. 12345678",
  );
  expect(screen.getByLabelText(/Nombres/)).toHaveAttribute(
    "placeholder",
    "Ej. Ana",
  );
  fireEvent.change(screen.getByLabelText(/Tipo de documento/), {
    target: { value: "CC" },
  });
  fireEvent.change(screen.getByLabelText(/Número de documento/), {
    target: { value: "123456789" },
  });
  fireEvent.change(screen.getByLabelText(/Nombres/), {
    target: { value: "Ada" },
  });
  fireEvent.change(screen.getByLabelText(/Primer apellido/), {
    target: { value: "Example" },
  });
  fireEvent.change(screen.getByLabelText(/Sexo/), { target: { value: "F" } });
  fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/), {
    target: { value: "1990-01-01" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
  expect(
    await screen.findByLabelText(/Código de ciudad de residencia/),
  ).toHaveAttribute(
    "placeholder",
    "Buscar ciudad (ej. Bogotá, Medellín, Cali)...",
  );
  expect(screen.getByLabelText(/Dirección/)).toHaveAttribute(
    "placeholder",
    "Ej. Calle 1 # 2-3",
  );
  expect(screen.getByLabelText(/Teléfono/)).toHaveAttribute(
    "placeholder",
    "Ej. 3001234567",
  );
  expect(screen.getByLabelText(/Correo electrónico/)).toHaveAttribute(
    "placeholder",
    "ejemplo@correo.com",
  );
});

it("hides the city suggestions while the quote is pending", async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({
      matches: [{ code: "11001", city: "Bogotá", department: "Bogotá D.C." }],
    }),
  );
  render(
    <PublicQuoteForm
      definition={quoteDefinition}
      endpoint="https://api.test/api/public/forms/quote-token"
    />,
  );
  fireEvent.change(await screen.findByLabelText(/Placa/), {
    target: { value: "TESTCAR" },
  });
  fireEvent.change(screen.getByLabelText(/Código Reference/), {
    target: { value: "12345678" },
  });
  fireEvent.change(screen.getByLabelText(/Año del vehículo/), {
    target: { value: "2023" },
  });
  fireEvent.change(screen.getByLabelText(/Código de ciudad de circulación/), {
    target: { value: "11001" },
  });
  fireEvent.change(screen.getByLabelText(/Valor declarado/), {
    target: { value: "50000000" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
  fireEvent.change(await screen.findByLabelText(/Tipo de documento/), {
    target: { value: "CC" },
  });
  fireEvent.change(screen.getByLabelText(/Número de documento/), {
    target: { value: "123456789" },
  });
  fireEvent.change(screen.getByLabelText(/Nombres/), {
    target: { value: "Ada" },
  });
  fireEvent.change(screen.getByLabelText(/Primer apellido/), {
    target: { value: "Example" },
  });
  fireEvent.change(screen.getByLabelText(/Sexo/), { target: { value: "F" } });
  fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/), {
    target: { value: "1990-01-01" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Siguiente paso/ }));
  const city = await screen.findByLabelText(/Código de ciudad de residencia/);
  fireEvent.change(city, { target: { value: "bog" } });
  expect(await screen.findByText("Bogotá (Bogotá D.C.)")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/Dirección/), {
    target: { value: "Example 123" },
  });
  fireEvent.change(screen.getByLabelText(/Teléfono/), {
    target: { value: "3001234567" },
  });
  fireEvent.change(screen.getByLabelText(/Correo electrónico/), {
    target: { value: "ada@example.test" },
  });
  await solve();
  fetchMock.mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: /Enviar solicitud/ }));
  expect(
    await screen.findByText(/Cotizando con proveedores/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

function LocaleSwitcher() {
  const setLocale = useSetLocale();
  return (
    <>
      <button onClick={() => setLocale("es")}>ES</button>
      <button onClick={() => setLocale("en")}>EN</button>
    </>
  );
}

it("keeps field names and step controls across locales with Spanish by default", async () => {
  testingRender(
    <StoreContextProvider value={memoryStore({ locale: "es" })}>
      <AppLocaleProvider>
        <LocaleSwitcher />
        <PublicQuoteForm
          definition={quoteDefinition}
          endpoint="https://api.test/api/public/forms/quote-token"
        />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  // Spanish by default.
  expect(await screen.findByText("COTIZACIONES")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Cotizador por pasos" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Vehículo")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Siguiente paso" }),
  ).toBeInTheDocument();
  const plate = screen.getByLabelText(/Placa/);
  fireEvent.change(plate, { target: { value: "TESTCAR" } });

  fireEvent.click(screen.getByText("EN"));
  await screen.findByText("QUOTES");
  expect(
    screen.getByRole("heading", { name: "Step-by-step quote" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Vehicle")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next step" })).toBeInTheDocument();
  // Business content preserved, field names intact.
  expect(screen.getByLabelText(/Placa/)).toHaveValue("TESTCAR");
  expect(widget?.language).toBe("en");
});
