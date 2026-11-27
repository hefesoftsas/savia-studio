import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "@/app-services";
import { AppServicesProvider } from "./assistant-context";
import { AssistantActionCard } from "./assistant-bar";

const action = {
  actionId: "pending-17",
  domain: "agencies",
  command: "update",
  expiresAt: "2026-09-02T12:05:00.000Z",
  input: { displayName: "Savia Norte", isActive: true },
  requiresConfirmation: true as const,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AssistantActionCard", () => {
  it("executes a prepared change only after the user confirms it", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json({
        state: init?.method === "POST" ? "completed" : "pending",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const services = {
      authSession: { getAccessToken: vi.fn().mockResolvedValue("token-17") },
    } as unknown as AppServices;
    const user = userEvent.setup();

    render(
      <AppServicesProvider services={services}>
        <AssistantActionCard action={action} />
      </AppServicesProvider>,
    );

    expect(fetcher).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.getByText("displayName")).toBeVisible();
    expect(screen.getByText("Savia Norte")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirmar cambio" }));

    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/assistant/actions/pending-17/confirm"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText("Cambio ejecutado.")).toBeVisible();
  });

  it.each([
    {
      state: "completed",
      button: "Confirmar cambio",
      message: "Cambio ejecutado.",
    },
    { state: "cancelled", button: "Cancelar", message: "Cambio cancelado." },
  ])(
    "recovers a $state change when the response is lost without resending it",
    async ({ state, button, message }) => {
      let submitted = false;
      const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          submitted = true;
          throw new TypeError("Network request failed");
        }
        return Response.json({ state: submitted ? state : "pending" });
      });
      vi.stubGlobal("fetch", fetcher);
      const services = {
        authSession: { getAccessToken: vi.fn().mockResolvedValue("token-17") },
      } as unknown as AppServices;
      render(
        <AppServicesProvider services={services}>
          <AssistantActionCard action={action} />
        </AppServicesProvider>,
      );

      await userEvent.click(screen.getByRole("button", { name: button }));

      expect(await screen.findByText(message)).toBeVisible();
      expect(
        fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: "Confirmar cambio" }),
      ).not.toBeInTheDocument();
    },
  );

  it("allows a status check during an interrupted confirmation without offering to resend it", async () => {
    let submitted = false;
    let statusAvailable = false;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        submitted = true;
        return Response.json({ error: "Gateway timeout" }, { status: 504 });
      }
      if (submitted && !statusAvailable)
        return Response.json({ error: "Unavailable" }, { status: 503 });
      return Response.json({ state: submitted ? "completed" : "pending" });
    });
    vi.stubGlobal("fetch", fetcher);
    const services = {
      authSession: { getAccessToken: vi.fn().mockResolvedValue("token-17") },
    } as unknown as AppServices;
    render(
      <AppServicesProvider services={services}>
        <AssistantActionCard action={action} />
      </AppServicesProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirmar cambio" }),
    );

    expect(
      await screen.findByText("No pudimos consultar el estado de la acción."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Confirmar cambio" }),
    ).not.toBeInTheDocument();
    statusAvailable = true;
    await userEvent.click(
      screen.getByRole("button", { name: "Verificar estado" }),
    );

    expect(await screen.findByText("Cambio ejecutado.")).toBeVisible();
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("restores a running proposal and shows the saved result when it finishes", async () => {
    let state = "executing";
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ state }),
    );
    vi.stubGlobal("fetch", fetcher);
    const services = {
      authSession: { getAccessToken: vi.fn().mockResolvedValue("token-17") },
    } as unknown as AppServices;
    render(
      <AppServicesProvider services={services}>
        <AssistantActionCard action={action} />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByText("Verificando el estado de la acción…"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Confirmar cambio" }),
    ).not.toBeInTheDocument();
    state = "completed";

    expect(
      await screen.findByText("Cambio ejecutado.", undefined, {
        timeout: 4_500,
      }),
    ).toBeVisible();
    expect(
      fetcher.mock.calls.every(([, init]) => init?.method !== "POST"),
    ).toBe(true);
  });

  it("renders friendly CRM action title and flattens data fields", () => {
    const services = {
      authSession: { getAccessToken: vi.fn() },
    } as unknown as AppServices;

    const crmAction = {
      actionId: "crm-1",
      domain: "cartera",
      command: "create-record",
      expiresAt: "2026-09-02T12:05:00.000Z",
      input: {
        collection: "cartera",
        data: { name: "juancho", number_1: 10000000 },
      },
      requiresConfirmation: true as const,
    };

    render(
      <AppServicesProvider services={services}>
        <AssistantActionCard action={crmAction} />
      </AppServicesProvider>,
    );

    expect(screen.getByText('Crear registro en "cartera"')).toBeVisible();
    expect(screen.getByText("collection")).toBeVisible();
    expect(screen.getByText("name")).toBeVisible();
    expect(screen.getByText("juancho")).toBeVisible();
    expect(screen.getByText("number_1")).toBeVisible();
    expect(screen.getByText("10000000")).toBeVisible();
  });
});

it("shows the saved quotation link and evidence-based comparison after confirmation", async () => {
  const quoteResult = {
    quoteId: "q1",
    reference: "COT-1",
    url: "/#/crm?tenantId=0&object=cotizador_por_pasos&quote=q1",
    failedOffers: 1,
    unpricedOffers: 0,
    pricedOffers: 1,
    lowestPremium: 1000,
    lowestPriceOffers: [
      {
        provider: "Example Omega",
        product: "Example Omega Full",
        premium: 1000,
      },
    ],
    tiedOfferCount: 1,
    recommendation: "Faltan detalles para elegir.",
    persistenceWarnings: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url, init) =>
      Promise.resolve(
        Response.json(
          init?.method === "POST"
            ? {
                state: "completed",
                result: {
                  content: [
                    { type: "text", text: JSON.stringify(quoteResult) },
                  ],
                },
              }
            : { state: "pending" },
        ),
      ),
    ),
  );
  const services = {
    authSession: { getAccessToken: vi.fn().mockResolvedValue("token") },
  } as unknown as AppServices;
  render(
    <AppServicesProvider services={services}>
      <AssistantActionCard
        action={{
          ...action,
          domain: "service",
          command: "quote-auto",
          input: { vehicle: { plate: "TESTCAR" } },
        }}
      />
    </AppServicesProvider>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirmar y cotizar" }),
  );
  expect(
    await screen.findByRole("link", {
      name: "Ver cotización y comparar ofertas",
    }),
  ).toHaveAttribute("href", quoteResult.url);
  expect(screen.getByText("Faltan detalles para elegir.")).toBeVisible();
  vi.unstubAllGlobals();
});

it.each(["failed", "expired"])(
  "recovers a %s quote without presenting it as cancelled or offering replay",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(Response.json({ state: status })),
        ),
    );
    const services = {
      authSession: { getAccessToken: vi.fn().mockResolvedValue("token") },
    } as unknown as AppServices;
    render(
      <AppServicesProvider services={services}>
        <AssistantActionCard
          action={{ ...action, domain: "service", command: "quote-auto" }}
        />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByText(
        status === "failed"
          ? /La cotización no pudo completarse/
          : /La confirmación venció/,
      ),
    ).toBeVisible();
    expect(screen.queryByText("Cambio cancelado.")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirmar y cotizar" }),
    ).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  },
);

it("formats quote values for people rather than exposing raw booleans and amounts", async () => {
  const { formatQuoteField } = await import("./assistant-quote-result");
  expect(formatQuoteField(false, "vehicle.isNew")).toBe("No");
  expect(formatQuoteField("M", "applicant.gender")).toBe("Masculino");
  expect(formatQuoteField("1984-08-26", "applicant.birthDate")).toBe(
    "26/08/1984",
  );
  expect(formatQuoteField(16000000, "vehicle.declaredValue")).toContain(
    "16.000.000",
  );
});
