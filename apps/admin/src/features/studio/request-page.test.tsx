import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { render } from "../studio-engine/test/locale-test-render";
import userEvent from "@testing-library/user-event";
import RequestPage from "@/features/studio-engine/request-page";
import { setStudioRuntime } from "@/features/studio-engine/runtime";
import { requestPageSchema } from "@savia/studio-shared/request-page";
import type { StudioObject } from "@savia/studio-shared/metadata";
const object: StudioObject = {
  name: "quote",
  label: "Cotizador generado",
  description: "",
  config: {
    version: 2,
    fields: { plate: { type: "Textbox", label: "Placa", required: true } },
    fieldOrder: ["plate"],
    studio: {
      requestPage: requestPageSchema.parse({
        version: 1,
        source: "savia-request",
        resultColumns: [
          { label: "Referencia", pointer: "/reference", format: "text" },
        ],
        actions: [
          {
            id: "quote",
            label: "Proveedor",
            operationId: "execute_quote",
            kind: "submit",
            input: { plate: "plate" },
          },
        ],
      }),
    },
  },
};
afterEach(() => {
  cleanup();
  setStudioRuntime({ embedded: false });
});
describe("generated request page runtime", () => {
  it.each([
    { interrupted: true, error: "Quote response was lost" },
    {
      interrupted: false,
      error: "La respuesta no confirmó la ejecución solicitada.",
    },
  ])(
    "recovers a committed quote after $error without repeating the provider call",
    async ({ interrupted, error }) => {
      const user = userEvent.setup();
      const runs = new Map<string, Record<string, unknown>>();
      const submitted: string[] = [];
      const transport = vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method !== "POST") {
          if (submitted.length === 1) throw new Error("History is offline");
          return Response.json({ data: [...runs.values()].reverse() });
        }
        const body = JSON.parse(String(init.body));
        submitted.push(body.id);
        if (!runs.has(body.id))
          runs.set(body.id, {
            ...body,
            label: "Cotización guardada",
            status: "complete",
            result: null,
            error: null,
            createdAt: new Date().toISOString(),
          });
        if (submitted.length === 1) {
          if (interrupted) throw new Error(error);
          return Response.json({ id: "unrelated-receipt", status: "complete" });
        }
        return Response.json(runs.get(body.id));
      });
      setStudioRuntime({
        embedded: true,
        tenantId: 0,
        requestTransport: transport,
      });
      render(<RequestPage object={object} />);
      await user.selectOptions(
        screen.getByRole("combobox", { name: "Modo de ejecución" }),
        "mock",
      );
      await user.type(
        screen.getByRole("textbox", { name: /Placa/ }),
        "TESTCAR",
      );
      const submit = () => screen.getByRole("button", { name: "Ejecutar" });
      await user.click(submit());
      await screen.findByText(error);
      await waitFor(() => expect(submit()).toBeEnabled());

      await user.click(submit());
      await screen.findByText("Cotización guardada");
      expect(submitted).toHaveLength(2);
      expect(submitted[1]).toBe(submitted[0]);
      expect(runs.size).toBe(1);

      await waitFor(() => expect(submit()).toBeEnabled());
      await user.click(submit());
      await waitFor(() => expect(submitted).toHaveLength(3));
      expect(submitted[2]).not.toBe(submitted[0]);
      expect(runs.size).toBe(2);
    },
  );

  it("retries only the unresolved operation in a multi-operation quote", async () => {
    const user = userEvent.setup();
    const page = structuredClone(object);
    const actions = page.config.studio!.requestPage!.actions;
    actions.push({
      ...actions[0],
      id: "second",
      operationId: "execute_second",
      label: "Segunda operación",
    });
    const executions = new Map<string, Record<string, unknown>>();
    const posts: Array<{ actionId: string; id: string }> = [];
    let historyOffline = false;
    const transport = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        if (historyOffline) throw new Error("History is offline");
        return Response.json({ data: [...executions.values()] });
      }
      const body = JSON.parse(String(init.body));
      const persisted = executions.get(body.id);
      posts.push({ actionId: body.actionId, id: body.id });
      if (persisted) {
        historyOffline = false;
        return Response.json(persisted);
      }
      const saved = {
        ...body,
        label:
          body.actionId === "second"
            ? "Resultado de segunda operación"
            : "Resultado confirmado",
        status: "complete",
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
      };
      executions.set(body.id, saved);
      if (body.actionId === "second") {
        historyOffline = true;
        throw new Error("Second response was lost");
      }
      return Response.json(saved);
    });
    setStudioRuntime({
      embedded: true,
      tenantId: 0,
      requestTransport: transport,
    });
    render(<RequestPage object={page} />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Modo de ejecución" }),
      "mock",
    );
    await user.type(screen.getByRole("textbox", { name: /Placa/ }), "TESTCAR");
    await user.click(
      screen.getByText("Cotizar con", { selector: "summary span" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Segunda operación" }),
    );
    const submit = () => screen.getByRole("button", { name: "Ejecutar" });
    await user.click(submit());
    await screen.findByText("Second response was lost");
    await waitFor(() => expect(submit()).toBeEnabled());

    await user.click(submit());
    await screen.findByText("Resultado de segunda operación");
    expect(posts.map(({ actionId }) => actionId)).toEqual([
      "quote",
      "second",
      "second",
    ]);
    expect(posts[2].id).toBe(posts[1].id);
    expect(executions.size).toBe(2);
  });

  it("executes the selected request with the form values and restores results without repeating it", async () => {
    const user = userEvent.setup();
    let runs: any[] = [];
    const transport = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const saved = {
          ...body,
          label: "Proveedor",
          status: "complete",
          result: {
            type: "quote",
            status: "success",
            errors: [],
            warnings: [],
            metadata: { simulated: true },
            data: {
              offers: [
                {
                  provider: "Demo",
                  product: { name: "Plan" },
                  premium: { total: 1200000, currency: "COP" },
                  reference: "QA-1",
                  details: [{ label: "Lead time", value: "5 days" }],
                },
              ],
            },
          },
          error: null,
          createdAt: new Date().toISOString(),
        };
        runs = [saved];
        return Response.json(saved);
      }
      return Response.json({ data: runs });
    });
    setStudioRuntime({
      embedded: true,
      tenantId: 0,
      requestTransport: transport,
    });
    const mounted = render(<RequestPage object={object} />);
    await screen.findByText(
      "Al ejecutar una operación, sus resultados aparecerán aquí.",
    );
    expect(
      transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Modo de ejecución" }),
      "mock",
    );
    await user.type(screen.getByRole("textbox", { name: /Placa/ }), "TESTCAR");
    await user.click(screen.getByRole("button", { name: "Ejecutar" }));
    await screen.findByText("QA-1");
    expect(runs[0].values.plate).toBe("TESTCAR");
    expect(runs[0].mode).toBe("mock");
    mounted.unmount();
    render(<RequestPage object={object} />);
    await screen.findByText("QA-1");
    expect(
      transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cargar datos" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /Placa/ })).toHaveValue(
        "TESTCAR",
      ),
    );
  });
  it("runs a field lookup without submitting the quote and rejects stale responses", async () => {
    const user = userEvent.setup();
    const page = structuredClone(object);
    page.config.fields.year = { type: "Number", label: "Año" };
    page.config.fieldOrder!.push("year");
    page.config.studio!.requestPage!.actions.push({
      id: "lookup",
      operationId: "execute_lookup",
      label: "Consultar placa",
      kind: "lookup",
      input: { plate: "plate" },
      output: { year: "/data/vehicle/year" },
    });
    let resolveRun: (response: Response) => void = () => {};
    const transport = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ data: [] });
      return new Promise<Response>((resolve) => {
        resolveRun = resolve;
      });
    });
    setStudioRuntime({
      embedded: true,
      tenantId: 0,
      requestTransport: transport,
    });
    render(<RequestPage object={page} />);
    await screen.findByText(
      "Al ejecutar una operación, sus resultados aparecerán aquí.",
    );
    await user.type(screen.getByRole("textbox", { name: /Placa/ }), "TESTCAR");
    await user.click(screen.getByRole("button", { name: "Consultar placa" }));
    await user.clear(screen.getByRole("textbox", { name: /Placa/ }));
    await user.type(screen.getByRole("textbox", { name: /Placa/ }), "TESTALT");
    resolveRun(
      Response.json({
        id: JSON.parse(
          String(
            transport.mock.calls.find(
              ([, init]) => init?.method === "POST",
            )?.[1]?.body,
          ),
        ).id,
        actionId: "lookup",
        label: "Consulta",
        mode: "mock",
        status: "complete",
        createdAt: new Date().toISOString(),
        values: { plate: "TESTCAR" },
        result: {
          type: "vehicle_lookup",
          status: "success",
          data: { vehicle: { plate: "TESTCAR", year: 2024 } },
          errors: [],
          warnings: [],
          metadata: { simulated: true },
        },
      }),
    );
    await screen.findByText(
      "Cambió la entrada; consulta de nuevo para completar los campos.",
    );
    expect(screen.getByRole("spinbutton", { name: "Año" })).not.toHaveValue(
      2024,
    );
    expect(
      transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cargar datos" }));
    expect(screen.getByRole("checkbox", { name: "Proveedor" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Ejecutar" }));
    await waitFor(() =>
      expect(
        transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(2),
    );
    const posts = transport.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(posts[1][1]?.body)).actionId).toBe("quote");
    resolveRun(
      Response.json({
        id: JSON.parse(String(posts[1][1]?.body)).id,
        actionId: "quote",
        label: "Proveedor",
        mode: "mock",
        status: "failed",
        createdAt: new Date().toISOString(),
        values: { plate: "TESTCAR" },
        result: null,
        error: "Test",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ejecutar" })).toBeEnabled(),
    );
  });

  it.each(["steps", "conversation"] as const)(
    "keeps lookup results while navigating a %s wizard without quoting early",
    async (presentation) => {
      const user = userEvent.setup();
      const page = structuredClone(object);
      page.config.fields.plate.config = { step: "vehicle" };
      page.config.fields.year = {
        type: "Number",
        label: "Año",
        required: true,
        config: { step: "details" },
      };
      page.config.fieldOrder!.push("year");
      page.config.studio!.wizard = {
        enabled: true,
        presentation,
        steps: [
          { id: "vehicle", title: "Vehículo" },
          { id: "details", title: "Detalles" },
        ],
      };
      page.config.studio!.requestPage!.actions.push({
        id: "lookup",
        operationId: "lookup",
        label: "Consultar placa",
        kind: "lookup",
        input: { plate: "plate" },
        output: { year: "/data/vehicle/year" },
      });
      const transport = vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method !== "POST") return Response.json({ data: [] });
        const body = JSON.parse(String(init.body));
        return Response.json({
          ...body,
          label: "Consulta",
          status: "complete",
          createdAt: new Date().toISOString(),
          result: {
            type: "vehicle_lookup",
            status: "success",
            data: { vehicle: { plate: "REDACTD", year: 2024 } },
            errors: [],
            warnings: [],
            metadata: { simulated: true },
          },
        });
      });
      setStudioRuntime({
        embedded: true,
        tenantId: 0,
        requestTransport: transport,
      });
      render(<RequestPage object={page} />);
      await user.type(
        screen.getByRole("textbox", { name: /Placa/ }),
        "REDACTD",
      );
      expect(
        screen.queryByRole("region", { name: "Resultados de la página" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Resultados" }));
      expect(
        screen.getByRole("region", { name: "Resultados de la página" }),
      ).toBeVisible();
      await user.click(
        screen.getByRole("button", { name: "Preparar cotización" }),
      );
      expect(screen.getByRole("textbox", { name: /Placa/ })).toHaveValue(
        "REDACTD",
      );

      await user.click(screen.getByRole("button", { name: "Consultar placa" }));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Consultar placa" }),
        ).toBeEnabled(),
      );
      await user.click(
        screen.getByRole("button", {
          name: presentation === "steps" ? "Siguiente paso" : /Continuar/,
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole("spinbutton", { name: "Año" })).toHaveValue(
          2024,
        ),
      );
      expect(
        transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    },
  );
});
