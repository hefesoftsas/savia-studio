// @vitest-environment jsdom
import "fake-indexeddb/auto";
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { render } from "./locale-test-render";
import Root from "../app";
import { getStudioRuntime, setStudioRuntime } from "../runtime";
import { createStudioQueryClient } from "../studio-query-cache";
import { getListObjectsQueryKey } from "../generated/studio";
import { makeConfig } from "@savia/studio-shared/metadata";
import { toast } from "sonner";
import { openLocalStore } from "@/local-data/store";
import { createLocalTransport } from "@/local-data/transport";

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  setStudioRuntime({ embedded: false });
});

const agencyProfiles = {
  name: "agency_profiles",
  label: "Perfiles de agencia",
  description: "",
  config: makeConfig({
    displayName: { type: "Textbox", label: "organization · displayName" },
    shortName: { type: "Textbox", label: "organization · shortName" },
    email: { type: "Textbox", label: "channels · email" },
    internalId: { type: "Textbox", label: "administration · id" },
  }),
};
const sourceAgencyProfiles = {
  ...agencyProfiles,
  config: {
    ...agencyProfiles.config,
    studio: {
      collection: {
        sourceId: "agency-network",
        resource: "agency-profiles",
        kind: "domain" as const,
        domain: "agency-network",
        collection: "agency-profiles",
        capabilities: {
          list: true,
          read: true,
          create: true,
          update: true,
          delete: false,
          schema: false,
          customFields: false,
          filter: true,
          sort: true,
        },
      },
    },
  },
};
const studioAgencyProfiles = {
  ...sourceAgencyProfiles,
  config: {
    ...sourceAgencyProfiles.config,
    studio: {
      ...sourceAgencyProfiles.config.studio,
      collection: {
        ...sourceAgencyProfiles.config.studio!.collection!,
        kind: "crm" as const,
      },
    },
  },
};

const hubspotContacts = {
  name: "hubspot_contacts",
  label: "Contactos",
  description: "",
  count: 0,
  config: {
    ...makeConfig({ firstname: { type: "Textbox", label: "Nombre" } }),
    studio: {
      collection: {
        ...studioAgencyProfiles.config.studio.collection,
        kind: "crm" as const,
        sourceId: "hubspot",
        resource: "contacts",
        capabilities: {
          ...studioAgencyProfiles.config.studio.collection.capabilities,
          search: true,
          filter: false,
          sort: false,
        },
      },
    },
  },
};

it.each(["table", "editor"])(
  "confirms an offline save and queues deletion of an unversioned record from the %s",
  async (surface) => {
    const object = {
      name: "local_records",
      label: "Registros locales",
      description: "",
      config: makeConfig({ name: { type: "Textbox", label: "Nombre" } }),
    };
    const store = await openLocalStore(crypto.randomUUID());
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const offline = vi
      .spyOn(window.navigator, "onLine", "get")
      .mockReturnValue(false);
    try {
      await store.refreshManifest([
        {
          name: object.name,
          object,
          capability: "read-write",
          schemaVersion: 1,
        },
      ]);
      await store.applyPull(object.name, {
        documents: [],
        hasMore: false,
        cursor: "seed",
      });
      const network = vi.fn(async (path: string) => {
        if (path.startsWith(`/api/records/${object.name}`))
          throw new Error("Fixture record requests must be served locally");
        if (path === "/api/objects") return Response.json({ data: [object] });
        if (path === "/api/bootstrap") return Response.json({ ok: true });
        return Response.json({ data: [], total: 0 });
      });
      const syncNow = vi.fn(async () => {});
      const transport = createLocalTransport(store, network, syncNow);
      setStudioRuntime({
        embedded: true,
        businessSetupEnabled: false,
        apiBasePath: "/v1/studio/999",
        transport,
        localWorkspace: {
          scope: store.scope,
          store,
          transport,
          syncNow,
          requestSync: vi.fn(),
          resolveBundle: vi.fn(),
          close: vi.fn(),
        },
      });
      const client = createStudioQueryClient();
      const root = (search: string) => (
        <Root embedded search={search} queryClient={client} />
      );
      const view = render(root(`object=${object.name}&view=create`));
      fireEvent.input(await screen.findByLabelText("Nombre"), {
        target: { value: "Registro de prueba" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Guardar registro" }));
      await waitFor(() => expect(success).toHaveBeenCalled());
      expect
        .soft(success)
        .toHaveBeenCalledWith(
          "Guardado en este dispositivo · sincronización pendiente",
        );
      const [created] = await store.db.outbox.toArray();
      expect(created).toMatchObject({
        action: "create",
        data: { name: "Registro de prueba" },
      });
      expect(
        (await store.get(object.name, created.id))?._version,
      ).toBeUndefined();

      if (surface === "table") {
        fireEvent.click(
          await screen.findByRole("button", {
            name: "Eliminar Registro de prueba",
          }),
        );
        const confirm = await screen.findByRole("dialog", {
          name: "Eliminar Registro de prueba",
        });
        fireEvent.click(
          within(confirm).getByRole("button", { name: "Mover a papelera" }),
        );
      } else {
        view.rerender(
          root(`object=${object.name}&view=edit&record=${created.id}`),
        );
        fireEvent.click(
          await screen.findByRole("button", { name: "Mover a papelera" }),
        );
        await screen.findByText("¿Mover este registro a la papelera?");
        fireEvent.click(
          screen.getByRole("button", { name: "Mover a papelera" }),
        );
      }
      await waitFor(() =>
        expect(success).toHaveBeenCalledWith(
          "Movido a la papelera en este dispositivo · sincronización pendiente",
        ),
      );
      const mutations = await store.db.outbox.orderBy("sequence").toArray();
      expect(mutations.map(({ action, id }) => [action, id])).toEqual([
        ["create", created.id],
        ["delete", created.id],
      ]);
      expect((await store.get(object.name, created.id))?.deleted_at).toEqual(
        expect.any(String),
      );
      if (surface === "table") {
        fireEvent.click(
          await screen.findByRole("button", { name: "Papelera" }),
        );
        fireEvent.click(
          await screen.findByRole("button", {
            name: "Restaurar Registro de prueba",
          }),
        );
        const confirm = await screen.findByRole("dialog", {
          name: "Restaurar Registro de prueba",
        });
        fireEvent.click(
          within(confirm).getByRole("button", { name: "Restaurar" }),
        );
        await waitFor(() =>
          expect(error).toHaveBeenCalledWith(
            "Hay cambios locales pendientes. Sincroniza o resuelve los conflictos antes de restaurar.",
          ),
        );
        expect(await store.db.outbox.orderBy("sequence").toArray()).toEqual(
          mutations,
        );
      }
      expect(
        network.mock.calls.filter(([path]) =>
          path.startsWith(`/api/records/${object.name}`),
        ),
      ).toEqual([]);
    } finally {
      cleanup();
      offline.mockRestore();
      success.mockRestore();
      error.mockRestore();
      await store.destroy();
    }
  },
);

it("keeps configuration entry in the view controls instead of duplicating it in the record header", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [] });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const records = await screen.findByRole(
    "region",
    { name: "Registros de Perfiles de agencia" },
    { timeout: 5000 },
  );
  expect(
    screen.getByRole("button", { name: "Configurar vista" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Configurar" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Nuevo" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Nuevo registro" }),
  ).not.toBeInTheDocument();
  expect(within(records).getByText("Savia")).toBeVisible();
  expect(
    screen.queryByRole("checkbox", { name: "Seleccionar página" }),
  ).not.toBeInTheDocument();
});

it("retains the loaded record table when a same-scope refresh fails transiently", async () => {
  let recordReads = 0;
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles")) {
      recordReads += 1;
      if (recordReads > 1) throw new Error("Temporary record refresh failure");
      return Response.json({
        data: [{ id: "agency-1", displayName: "Savia" }],
        total: 1,
      });
    }
    return Response.json({ data: {} });
  });
  setStudioRuntime({ embedded: true, tenantId: 0, transport });
  const queryClient = createStudioQueryClient();

  render(
    <Root
      embedded
      queryClient={queryClient}
      search="object=agency_profiles&view=records"
    />,
  );
  expect(await screen.findByText("Savia")).toBeVisible();
  expect(recordReads).toBe(1);

  void queryClient.invalidateQueries({ refetchType: "active" });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Temporary record refresh failure",
  );
  await waitFor(() => expect(recordReads).toBe(2));
  expect(screen.getByText("Savia")).toBeVisible();
});

it("hides cached record rows after a same-scope 403 refresh", async () => {
  let recordReads = 0;
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles")) {
      recordReads += 1;
      if (recordReads > 1)
        return Response.json(
          { message: "Permission revoked" },
          { status: 403 },
        );
      return Response.json({
        data: [{ id: "agency-1", displayName: "Savia" }],
        total: 1,
      });
    }
    return Response.json({ data: {} });
  });
  setStudioRuntime({ embedded: true, tenantId: 0, transport });
  const queryClient = createStudioQueryClient();

  render(
    <Root
      embedded
      queryClient={queryClient}
      search="object=agency_profiles&view=records"
    />,
  );
  expect(await screen.findByText("Savia")).toBeVisible();
  expect(recordReads).toBe(1);

  void queryClient.invalidateQueries({ refetchType: "active" });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    /403|forbidden|permission/i,
  );
  await waitFor(() => expect(recordReads).toBe(2));
  await waitFor(() =>
    expect(screen.queryByText("Savia")).not.toBeInTheDocument(),
  );
});

it("shows CRM as the first icon-only records column", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [studioAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
            _crmLinks: [
              {
                provider: "hubspot",
                label: "Contacto en HubSpot",
                url: "https://app.hubspot.com/contacts/51969008/record/0-1/247951049777",
              },
            ],
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const records = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  expect(within(records).getByText("Savia")).toBeVisible();
  const headers = within(records).getAllByRole("columnheader");
  expect(headers[0]).toHaveTextContent("CRM");
  const originLink = within(records).getByRole("link", {
    name: "Contacto en HubSpot",
  });
  expect(originLink.querySelector("svg")).not.toBeNull();
  expect(originLink.querySelector("span")).toBeNull();
});

it("lets CRM users hide the integration column from the table designer", async () => {
  let savedConfig: Record<string, unknown> | null = {
    columns: [
      "__crm_integration",
      "displayName",
      "shortName",
      "email",
      "internalId",
    ],
    columnOrder: [
      "__crm_integration",
      "displayName",
      "shortName",
      "email",
      "internalId",
    ],
    columnAliases: {},
  };
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/objects")
      return Response.json({ data: [studioAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({
        data: [],
        default: savedConfig ? { config: savedConfig } : null,
      });
    if (
      path === "/api/views/agency_profiles/default" &&
      init?.method === "PUT"
    ) {
      savedConfig = JSON.parse(String(init.body)).config;
      return Response.json({ data: { config: savedConfig } });
    }
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
            _crmLinks: [
              {
                provider: "hubspot",
                label: "Contacto en HubSpot",
                url: "https://app.hubspot.com/contacts/51969008/record/0-1/247951049777",
              },
            ],
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  fireEvent.click(
    await screen.findByRole("button", { name: "Configurar vista" }),
  );
  const panel = screen.getByRole("dialog", { name: "Configurar vista" });
  const visibility = within(panel).getByRole("switch", {
    name: "Visible CRM",
  });
  expect(visibility).toHaveAttribute("aria-checked", "true");
  fireEvent.click(visibility);
  expect(visibility).toHaveAttribute("aria-checked", "false");

  fireEvent.click(
    within(panel).getByRole("button", { name: "Guardar cambios" }),
  );
  await waitFor(() =>
    expect(savedConfig?.columns).not.toContain("__crm_integration"),
  );
});

it("opens a stale record URL through the collection currently visible", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [] });
    if (path === "/api/records/agency_profiles/12")
      return Response.json({
        data: {
          id: "12",
          displayName: "Agencia Norte",
          shortName: "AN",
          email: "norte@savia.test",
          internalId: "profile-12",
        },
      });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "12",
            displayName: "Agencia Norte",
            shortName: "AN",
            email: "norte@savia.test",
            internalId: "profile-12",
          },
        ],
        total: 1,
      });
    if (path === "/api/records/clientes/12")
      return Response.json(
        { error: "El registro no existe." },
        { status: 404 },
      );
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=clientes&view=records&record=12" />);

  expect(await screen.findByText("Agencia Norte")).toBeVisible();
  await waitFor(() =>
    expect(
      transport.mock.calls.some(
        ([path]) => path === "/api/records/agency_profiles/12",
      ),
    ).toBe(true),
  );
  expect(
    screen.queryByRole("heading", { name: "Registro no disponible" }),
  ).not.toBeInTheDocument();
});

it("opens a record link with punctuation without changing its identifier", async () => {
  const object = { ...agencyProfiles, name: "orders", label: "Orders" };
  const record = { id: "order#2026", displayName: "Order from Pages" };
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects") return Response.json({ data: [object] });
    if (path === "/api/records/orders/order%232026")
      return Response.json({ data: record });
    if (path.startsWith("/api/record-detail/orders/order%232026?"))
      return Response.json({ data: { record, relations: [] } });
    if (path.startsWith("/api/records/orders/"))
      return Response.json({ error: "Record not found" }, { status: 404 });
    return Response.json({ data: [], total: 0 });
  });
  setStudioRuntime({ embedded: true, tenantId: 24, transport });
  const search = new URLSearchParams({ object: "orders", record: record.id });
  render(<Root embedded search={search.toString()} />);

  expect(await screen.findByText("Order from Pages")).toBeVisible();
  expect(
    transport.mock.calls.some(([path]) =>
      path.startsWith("/api/record-detail/orders/order%232026?"),
    ),
  ).toBe(true);
});

it("does not open the same record ID in another collection when the linked collection is unavailable", async () => {
  const object = { ...agencyProfiles, name: "orders", label: "Orders" };
  const navigate = vi.fn();
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects") return Response.json({ data: [object] });
    if (path === "/api/records/orders/12")
      return Response.json({
        data: { id: "12", displayName: "Unrelated order" },
      });
    return Response.json({ data: [], total: 0 });
  });
  setStudioRuntime({ embedded: true, tenantId: 24, transport, navigate });
  render(<Root embedded search="object=missing&view=records&record=12" />);

  expect(
    await screen.findByRole("heading", { name: "Registro no disponible" }),
  ).toBeVisible();
  expect(
    transport.mock.calls.some(([path]) => path === "/api/records/orders/12"),
  ).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Volver a la lista" }));
  expect(navigate).toHaveBeenCalledWith("object=orders&view=records", false);
});

it.each(["records", "create", "designer", "remove-screen"])(
  "keeps a missing collection link out of unrelated collections in %s",
  async (view) => {
    const other = {
      ...agencyProfiles,
      name: "orders",
      label: "Unrelated orders",
    };
    const navigate = vi.fn();
    const transport = vi.fn(async (path: string) =>
      Response.json({ data: path === "/api/objects" ? [other] : [], total: 0 }),
    );
    setStudioRuntime({ embedded: true, tenantId: 24, transport, navigate });
    render(<Root embedded search={`object=missing&view=${view}`} />);

    expect(
      await screen.findByRole("heading", { name: "Colección no disponible" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /Unrelated orders/ }),
    ).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(
      transport.mock.calls.some(([path]) =>
        path.startsWith("/api/records/orders"),
      ),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Gestionar pantallas" }),
    );
    expect(navigate).toHaveBeenNthCalledWith(1, "view=screens", false);
  },
);

it("does not infer a collection for a record link with no collection identifier", async () => {
  const other = {
    ...agencyProfiles,
    name: "clientes",
    label: "Unrelated contacts",
  };
  const navigate = vi.fn();
  const transport = vi.fn(async (path: string) =>
    Response.json({ data: path === "/api/objects" ? [other] : [], total: 0 }),
  );
  setStudioRuntime({ embedded: true, tenantId: 24, transport, navigate });
  render(<Root embedded search="view=records&record=12" />);

  expect(
    await screen.findByRole("heading", { name: "Registro no disponible" }),
  ).toBeVisible();
  expect(
    transport.mock.calls.some(([path]) =>
      path.startsWith("/api/records/clientes"),
    ),
  ).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it("retries catalog verification without changing a saved record link", async () => {
  const object = { ...agencyProfiles, name: "orders", label: "Orders" };
  const record = { id: "12", displayName: "Linked order" };
  const navigate = vi.fn();
  let catalogReads = 0;
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects") {
      if (++catalogReads === 1)
        return Response.json({ error: "Catalog unavailable" }, { status: 503 });
      return Response.json({ data: [object] });
    }
    if (path === "/api/records/orders/12")
      return Response.json({ data: record });
    if (path.startsWith("/api/record-detail/orders/12?"))
      return Response.json({ data: { record, relations: [] } });
    return Response.json({ data: [], total: 0 });
  });
  setStudioRuntime({ embedded: true, tenantId: 24, transport, navigate });
  render(<Root embedded search="object=orders&view=records&record=12" />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Catalog unavailable",
  );
  expect(
    transport.mock.calls.some(([path]) => path === "/api/records/orders/12"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
  expect(await screen.findByText("Linked order")).toBeVisible();
  expect(catalogReads).toBe(2);
  expect(navigate).not.toHaveBeenCalled();
});

it("replaces a stale collection name in an embedded record URL", async () => {
  const navigate = vi.fn();
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [] });
    if (path === "/api/records/agency_profiles/12")
      return Response.json({
        data: {
          id: "12",
          displayName: "Agencia Norte",
          shortName: "AN",
          email: "norte@savia.test",
          internalId: "profile-12",
        },
      });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({ data: [], total: 0 });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
    navigate,
  });

  render(<Root embedded search="object=clientes&view=records&record=12" />);

  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      "object=agency_profiles&view=records&record=12",
      true,
    ),
  );
});

it("offers a CSV export for Agency profiles", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({ data: [], total: 0 });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  expect(
    await screen.findByRole("button", { name: "Exportar a CSV" }),
  ).toBeVisible();
});

it("prevents duplicate CSV downloads and waits for Retry-After", async () => {
  let finishExport!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finishExport = resolve;
  });
  const download = vi.fn(async () => pending);
  const reportError = vi
    .spyOn(toast, "error")
    .mockImplementation(() => "export-error");
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  setStudioRuntime({
    embedded: true,
    tenantId: 24,
    transport: async (path) => {
      if (path === "/api/objects")
        return Response.json({ data: [sourceAgencyProfiles] });
      if (path.startsWith("/api/export/agency_profiles?")) return download();
      return Response.json({ data: [], total: 0 });
    },
  });
  try {
    render(<Root embedded search="object=agency_profiles&view=records" />);
    const button = await screen.findByRole("button", {
      name: "Exportar a CSV",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(download).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(click).not.toHaveBeenCalled();

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    await act(async () => {
      finishExport(
        Response.json(
          { error: "HubSpot limit reached" },
          {
            status: 429,
            headers: { "Retry-After": "30" },
          },
        ),
      );
    });
    expect(reportError).toHaveBeenCalledWith("HubSpot limit reached", {
      description: expect.stringContaining("Puedes reintentar a partir de"),
    });
    act(() => vi.advanceTimersByTime(29_999));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");
    fireEvent.click(button);
    expect(download).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1));
    expect(button).toBeEnabled();
    expect(download).toHaveBeenCalledOnce();
    download.mockResolvedValueOnce(
      new Response("Nombre\r\nAna\r\n", {
        headers: { "Content-Type": "text/csv" },
      }),
    );
    await act(async () => {
      fireEvent.click(button);
    });
    expect(click).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledTimes(2);
    expect(button).toBeEnabled();
  } finally {
    vi.useRealTimers();
    click.mockRestore();
    reportError.mockRestore();
  }
});

it.each([
  ["crm", "salesforce"],
  ["crm", "zoho"],
  ["crm", "pipedrive"],
  ["postgres", "database-source"],
  ["jsonapi", "json-source"],
  ["mcp", "mcp-source"],
] as const)(
  "keeps records visible without an unsupported CSV action for %s / %s",
  async (kind, sourceId) => {
    const object = {
      ...agencyProfiles,
      name: "connected_records",
      label: "Registros conectados",
      config: {
        ...agencyProfiles.config,
        studio: {
          collection: {
            kind,
            sourceId,
            resource: "contacts",
            capabilities:
              sourceAgencyProfiles.config.studio.collection.capabilities,
          },
        },
      },
    };
    setStudioRuntime({
      embedded: true,
      tenantId: 24,
      transport: async (path) => {
        if (path === "/api/objects") return Response.json({ data: [object] });
        if (path.startsWith("/api/records/connected_records?"))
          return Response.json({
            data: [{ id: "1", displayName: "Cuenta de prueba" }],
            total: 1,
          });
        return Response.json({ data: [] });
      },
    });
    render(<Root embedded search="object=connected_records&view=records" />);

    expect(await screen.findByText("Cuenta de prueba")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Exportar a CSV" }),
    ).not.toBeInTheDocument();
  },
);

it("does not publish an empty navigation snapshot for a temporary object read failure", async () => {
  const postMessage = vi.spyOn(window, "postMessage");
  const queryClient = createStudioQueryClient();
  let status = 503;
  try {
    setStudioRuntime({
      embedded: true,
      tenantId: 24,
      sessionGeneration: 19,
      transport: async (path) => {
        if (new URL(path, "https://savia.test").pathname !== "/api/objects")
          return Response.json({ data: [] });
        if (status === 200) return Response.json({ data: [] });
        return Response.json(
          { error: status === 503 ? "Metadata unavailable" : "Access denied" },
          { status },
        );
      },
    });
    render(<Root embedded queryClient={queryClient} />);
    expect(await screen.findByText("Metadata unavailable")).toBeVisible();
    const navigationMessages = () =>
      postMessage.mock.calls
        .map(([value]) => value)
        .filter((value) => value?.type === "savia-studio-navigation");
    expect(navigationMessages()).toHaveLength(0);

    status = 200;
    await act(async () =>
      queryClient.invalidateQueries({ queryKey: getListObjectsQueryKey() }),
    );
    await waitFor(() =>
      expect(navigationMessages().at(-1)).toMatchObject({
        tenantId: 24,
        sessionGeneration: 19,
        objects: [],
      }),
    );
    expect(navigationMessages().at(-1)?.accessDenied).toBeUndefined();

    status = 403;
    await act(async () =>
      queryClient.invalidateQueries({ queryKey: getListObjectsQueryKey() }),
    );
    await waitFor(() =>
      expect(navigationMessages().at(-1)).toMatchObject({
        tenantId: 24,
        sessionGeneration: 19,
        accessDenied: true,
        objects: [],
      }),
    );
  } finally {
    postMessage.mockRestore();
  }
});

it("uses an unfiltered HubSpot list total when the summary is unavailable", async () => {
  const postMessage = vi.spyOn(window, "postMessage");
  const queryClient = createStudioQueryClient();
  const summaryRequest = vi.fn(() =>
    Response.json({ error: "Rate limited" }, { status: 429 }),
  );
  let listDenied = false;
  let listDisconnected = false;
  let listTotalAvailable = true;
  const refreshList = () =>
    act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["hubspot_contacts", "getList"],
      });
    });
  try {
    setStudioRuntime({
      embedded: true,
      tenantId: 24,
      sessionGeneration: 19,
      transport: async (path) => {
        const url = new URL(path, "https://savia.test");
        if (url.pathname === "/api/objects")
          return Response.json({ data: [hubspotContacts] });
        if (url.pathname === "/api/views/hubspot_contacts")
          return Response.json({
            data: [
              { id: "filtered", name: "Vista filtrada", config: { q: "Ana" } },
              {
                id: "whitespace",
                name: "Vista con espacios",
                config: { q: " " },
              },
            ],
            default: null,
          });
        if (url.pathname === "/api/records/hubspot_contacts/summary")
          return summaryRequest();
        if (url.pathname === "/api/records/hubspot_contacts") {
          if (listDenied)
            return Response.json({ error: "Acceso revocado" }, { status: 403 });
          if (listDisconnected)
            return Response.json(
              {
                error: {
                  code: "HUBSPOT_CONNECTION_UNAVAILABLE",
                  message: "Reconecta HubSpot.",
                },
              },
              { status: 409 },
            );
          const query = url.searchParams.get("q");
          const rows = query
            ? [
                {
                  id: "7",
                  firstname:
                    query === " " ? "Resultado con espacios" : "Ana filtrada",
                },
              ]
            : Array.from({ length: 6 }, (_, index) => ({
                id: String(index + 1),
                firstname: `Contacto ${index + 1}`,
              }));
          return Response.json({
            data: rows,
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
            ...(listTotalAvailable ? { total: rows.length } : {}),
          });
        }
        return Response.json({ data: [] });
      },
    });
    render(
      <Root
        embedded
        search="object=hubspot_contacts&view=records"
        queryClient={queryClient}
      />,
    );
    expect(await screen.findByText("Contacto 1")).toBeVisible();
    const heading = screen.getByRole("heading", { name: /Contactos/ });
    await waitFor(() => expect(within(heading).getByText("6")).toBeVisible());
    expect(summaryRequest).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "savia-studio-navigation",
          tenantId: 24,
          sessionGeneration: 19,
          hubspotCount: { name: "hubspot_contacts", total: 6 },
        }),
        window.location.origin,
      ),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Vista filtrada" }),
    );
    expect(await screen.findByText("Ana filtrada")).toBeVisible();
    expect(within(heading).getByText("6")).toBeVisible();
    expect(within(heading).queryByText("1")).not.toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "Vista con espacios" }),
    );
    expect(await screen.findByText("Resultado con espacios")).toBeVisible();
    expect(within(heading).getByText("6")).toBeVisible();

    fireEvent.click(
      await screen.findByRole("button", { name: "Todos los registros" }),
    );
    expect(await screen.findByText("Contacto 1")).toBeVisible();
    listTotalAvailable = false;
    await refreshList();
    await waitFor(() => expect(summaryRequest).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(heading).queryByText("6")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Contacto 1")).toBeVisible();

    listTotalAvailable = true;
    await refreshList();
    await waitFor(() => expect(within(heading).getByText("6")).toBeVisible());
    listDisconnected = true;
    await refreshList();
    expect(await screen.findByText("Reconecta HubSpot.")).toBeVisible();
    expect(screen.queryByText("Contacto 1")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(heading).queryByText("6")).not.toBeInTheDocument(),
    );
    expect(summaryRequest).toHaveBeenCalledOnce();
    listDisconnected = false;
    await act(async () =>
      fireEvent.click(
        within(screen.getByRole("alert")).getByRole("button", {
          name: "Reintentar",
        }),
      ),
    );
    expect(await screen.findByText("Contacto 1")).toBeVisible();
    expect(within(heading).getByText("6")).toBeVisible();
    listDenied = true;
    await refreshList();
    await waitFor(() =>
      expect(within(heading).queryByText("6")).not.toBeInTheDocument(),
    );
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({
      type: "savia-studio-navigation",
      hubspotCount: undefined,
    });
  } finally {
    postMessage.mockRestore();
  }
});

it("does not start a HubSpot summary when the list is rate-limited", async () => {
  const summary = vi.fn(() => Response.json({ data: [], total: 6 }));
  setStudioRuntime({
    embedded: true,
    tenantId: 24,
    transport: async (path) => {
      if (path === "/api/objects")
        return Response.json({ data: [hubspotContacts] });
      if (path === "/api/records/hubspot_contacts/summary") return summary();
      if (path.startsWith("/api/records/hubspot_contacts?"))
        return Response.json(
          { error: "Límite de HubSpot" },
          { status: 429, headers: { "Retry-After": "30" } },
        );
      return Response.json({ data: [] });
    },
  });
  render(<Root embedded search="object=hubspot_contacts&view=records" />);
  expect(await screen.findByText("Límite de HubSpot")).toBeVisible();
  expect(summary).not.toHaveBeenCalled();
});

it("retries the rate-limited HubSpot page in place with its original cursor", async () => {
  const requests: Array<{ page: number; cursor: string | null }> = [];
  let rateLimited = true;
  setStudioRuntime({
    embedded: true,
    tenantId: 24,
    transport: async (path) => {
      const url = new URL(path, "https://savia.test");
      if (url.pathname === "/api/objects")
        return Response.json({ data: [hubspotContacts] });
      if (url.pathname !== "/api/records/hubspot_contacts")
        return Response.json({ data: [] });
      const page = Number(url.searchParams.get("page"));
      requests.push({ page, cursor: url.searchParams.get("cursor") });
      if (page === 2 && rateLimited) {
        rateLimited = false;
        return Response.json(
          { error: "Límite de HubSpot" },
          { status: 429, headers: { "Retry-After": "30" } },
        );
      }
      return Response.json({
        data: [
          page === 1
            ? { id: "1", firstname: "Contacto 1" }
            : { id: "26", firstname: "Contacto 26" },
        ],
        total: 26,
        pageInfo: { hasNextPage: page === 1, hasPreviousPage: page > 1 },
        ...(page === 1 ? { nextCursor: "page-two" } : {}),
      });
    },
  });
  const page = render(
    <Root embedded search="object=hubspot_contacts&view=records" />,
  );
  expect(await screen.findByText("Contacto 1")).toBeVisible();
  vi.useFakeTimers({ toFake: ["Date"] });
  const startedAt = Date.parse("2026-10-03T12:00:00Z");
  vi.setSystemTime(startedAt);
  try {
    fireEvent.click(screen.getByRole("link", { name: /siguiente|next/i }));
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Límite de HubSpot");
    expect(warning).toHaveTextContent("Puedes reintentar a partir de");
    expect(screen.getByText("Contacto 1")).toBeVisible();
    const retry = within(warning).getByRole("button", { name: "Reintentar" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(requests).toHaveLength(2);
    vi.setSystemTime(startedAt + 30_000);
    page.rerender(
      <Root embedded search="object=hubspot_contacts&view=records" />,
    );
    expect(retry).toBeEnabled();
    expect(requests).toHaveLength(2);
    fireEvent.click(retry);
    expect(await screen.findByText("Contacto 26")).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
  expect(requests).toEqual([
    { page: 1, cursor: null },
    { page: 2, cursor: "page-two" },
    { page: 2, cursor: "page-two" },
  ]);
});

it("starts a new HubSpot search at page one when browsing a later page", async () => {
  const listRequests: Array<{
    page: number;
    query: string;
    cursor: string | null;
  }> = [];
  setStudioRuntime({
    embedded: true,
    tenantId: 24,
    transport: async (path) => {
      const url = new URL(path, "https://savia.test");
      if (url.pathname === "/api/objects")
        return Response.json({ data: [hubspotContacts] });
      if (url.pathname !== "/api/records/hubspot_contacts")
        return Response.json({ data: [] });
      const page = Number(url.searchParams.get("page"));
      const query = url.searchParams.get("q") ?? "";
      listRequests.push({
        page,
        query,
        cursor: url.searchParams.get("cursor"),
      });
      return Response.json({
        data: [
          {
            id: `${query}-${page}`,
            firstname: query ? `Ana página ${page}` : `Contacto página ${page}`,
          },
        ],
        total: 50,
        pageInfo: { hasNextPage: page === 1, hasPreviousPage: page > 1 },
        ...(page === 1
          ? { nextCursor: query ? "ana-page-two" : "page-two" }
          : {}),
      });
    },
  });
  render(<Root embedded search="object=hubspot_contacts&view=records" />);
  expect(await screen.findByText("Contacto página 1")).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: /siguiente|next/i }));
  expect(await screen.findByText("Contacto página 2")).toBeVisible();
  const search = screen.getByRole("textbox", { name: "Buscar en contactos" });
  fireEvent.change(search, { target: { value: "Ana" } });

  await waitFor(() =>
    expect(listRequests.some((request) => request.query === "Ana")).toBe(true),
  );
  expect(listRequests.filter((request) => request.query === "Ana")).toEqual([
    { page: 1, query: "Ana", cursor: null },
  ]);
  expect(await screen.findByText("Ana página 1")).toBeVisible();
  expect(screen.queryByText("Contacto página 2")).toBeNull();
});

it("loads the HubSpot summary when a filtered view settles before any unfiltered result", async () => {
  const unfiltered = Promise.withResolvers<Response>();
  const initialList = vi.fn(
    (_signal?: AbortSignal | null) => unfiltered.promise,
  );
  const summary = vi.fn(() => Response.json({ data: [], total: 6 }));
  setStudioRuntime({
    embedded: true,
    tenantId: 24,
    transport: async (path, init) => {
      const url = new URL(path, "https://savia.test");
      if (url.pathname === "/api/objects")
        return Response.json({ data: [hubspotContacts] });
      if (url.pathname === "/api/views/hubspot_contacts")
        return Response.json({
          data: [
            { id: "filtered", name: "Vista filtrada", config: { q: "Ana" } },
          ],
        });
      if (url.pathname === "/api/records/hubspot_contacts/summary")
        return summary();
      if (url.pathname === "/api/records/hubspot_contacts") {
        if (!url.searchParams.get("q")) return initialList(init?.signal);
        return Response.json({
          data: [{ id: "1", firstname: "Ana filtrada" }],
          total: 1,
        });
      }
      return Response.json({ data: [] });
    },
  });
  try {
    render(<Root embedded search="object=hubspot_contacts&view=records" />);
    await waitFor(() => expect(initialList).toHaveBeenCalledOnce());
    const initialSignal = initialList.mock.calls[0]?.[0];
    expect(initialSignal?.aborted).toBe(false);
    expect(summary).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", { name: "Vista filtrada" }),
    );
    expect(await screen.findByText("Ana filtrada")).toBeVisible();
    expect(initialSignal?.aborted).toBe(true);
    const heading = screen.getByRole("heading", { name: /Contactos/ });
    await waitFor(() => expect(within(heading).getByText("6")).toBeVisible());
    expect(summary).toHaveBeenCalledOnce();
  } finally {
    unfiltered.resolve(Response.json({ data: [], total: 0 }));
  }
});

it.each([false, true])(
  "uses only HubSpot-supported list and export settings (saved view selected: %s)",
  async (useSavedView) => {
    const transport = vi.fn(async (path: string) => {
      if (path === "/api/objects")
        return Response.json({ data: [hubspotContacts] });
      if (path === "/api/views/hubspot_contacts")
        return Response.json({
          data: [
            {
              id: "saved-search",
              name: "Vista anterior",
              config: {
                q: "Ana",
                searchField: "firstname",
                stage: "lead",
                group: "firstname",
                sort: { field: "firstname", order: "ASC" },
                filters: {
                  logic: "and",
                  conditions: [{ field: "firstname", op: "eq", value: "Ana" }],
                },
              },
            },
          ],
          default: null,
        });
      return Response.json({ data: [], total: 0 });
    });
    setStudioRuntime({ embedded: true, tenantId: 24, transport });
    render(<Root embedded search="object=hubspot_contacts&view=records" />);

    const exportButton = await screen.findByRole("button", {
      name: "Exportar a CSV",
    });
    const unsupported = ["filters", "stage", "searchField", "sort", "order"];
    if (useSavedView) {
      fireEvent.click(
        await screen.findByRole("button", { name: "Vista anterior" }),
      );
      expect(exportButton).toBeDisabled();
      fireEvent.click(exportButton);
      expect(
        transport.mock.calls.some(([path]) => path.startsWith("/api/export/")),
      ).toBe(false);
      await waitFor(() => expect(exportButton).toBeEnabled());
      const listRequests = transport.mock.calls
        .map(([path]) => new URL(path, "https://savia.test"))
        .filter((url) => url.pathname === "/api/records/hubspot_contacts");
      const filteredList = listRequests.find(
        (url) => url.searchParams.get("q") === "Ana",
      );
      expect(filteredList).toBeDefined();
      for (const parameter of unsupported)
        expect(filteredList?.searchParams.has(parameter), parameter).toBe(
          false,
        );

      const summary = transport.mock.calls
        .map(([path]) => new URL(path, "https://savia.test"))
        .find(
          (url) =>
            url.pathname === "/api/records/hubspot_contacts/summary" &&
            url.searchParams.get("q") === "Ana",
        );
      expect(summary?.searchParams.get("group")).toBe("firstname");
      expect(summary?.searchParams.has("searchField")).toBe(false);
      expect(summary?.searchParams.get("stage")).toBe("");
      expect(summary?.searchParams.get("filters")).toBe(
        '{"logic":"and","conditions":[]}',
      );
    }
    fireEvent.click(exportButton);

    const exportPath = transport.mock.calls.find(([path]) =>
      path.startsWith("/api/export/hubspot_contacts?"),
    )?.[0];
    expect(exportPath).toBeDefined();
    const query = new URL(exportPath!, "https://savia.test").searchParams;
    expect(query.get("q")).toBe(useSavedView ? "Ana" : "");
    expect(query.get("columns")).toBe('["firstname"]');
    for (const parameter of unsupported)
      expect(query.has(parameter), parameter).toBe(false);
  },
);

it.each([
  { field: "email", label: "channels · email", unavailable: false },
  {
    field: "old_email",
    label: "Campo no disponible (old_email)",
    unavailable: true,
  },
])(
  "keeps the saved search field identifiable when it is absent from visible columns ($field)",
  async ({ field, label, unavailable }) => {
    const object = { ...agencyProfiles, name: "saved_search_records" };
    const transport = vi.fn(async (path: string) => {
      if (path === "/api/objects") return Response.json({ data: [object] });
      if (path === "/api/views/saved_search_records")
        return Response.json({
          data: [
            {
              id: "saved-search",
              name: "Búsqueda guardada",
              config: {
                q: "Ana",
                searchField: field,
                columns: ["displayName"],
              },
            },
          ],
          default: null,
        });
      return Response.json({ data: [], total: 0 });
    });
    setStudioRuntime({ embedded: true, tenantId: 24, transport });
    render(<Root embedded search="object=saved_search_records&view=records" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Búsqueda guardada" }),
    );
    const selector = screen.getByRole("combobox", { name: "Buscar por campo" });
    expect(selector).toHaveValue(field);
    const option = within(selector).getByRole("option", { name: label });
    if (unavailable) expect(option).toBeDisabled();
    else expect(option).toBeEnabled();

    fireEvent.change(selector, { target: { value: "" } });
    expect(selector).toHaveValue("");
    await waitFor(() =>
      expect(
        transport.mock.calls.some(([path]) => {
          if (!path.startsWith("/api/records/saved_search_records?"))
            return false;
          const query = new URL(path, "https://savia.test").searchParams;
          return query.get("q") === "Ana" && !query.has("searchField");
        }),
      ).toBe(true),
    );
  },
);

it("offers a CSV export for local record tables", async () => {
  const localObject = {
    name: "test",
    label: "Test",
    description: "",
    config: makeConfig({
      nombre: { type: "Textbox", label: "Nombre" },
      html_personalizado: { type: "FormHtml", label: "HTML personalizado" },
    }),
  };
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects") return Response.json({ data: [localObject] });
    if (path === "/api/views/test")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/test"))
      return Response.json({
        data: [
          { id: "1", nombre: "Ejemplo", html_personalizado: "<p>Hola</p>" },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=test&view=records" />);

  expect(
    await screen.findByRole("button", { name: "Exportar a CSV" }),
  ).toBeVisible();
});

it.each([{ fields: [] }, { fields: ["displayName"] }])(
  "reflects scoped CSV permissions in the table ($fields)",
  async ({ fields }) => {
    const object = {
      ...agencyProfiles,
      name: "scoped_records",
      exportFields: fields,
    };
    const transport = vi.fn(async (path: string) => {
      if (path === "/api/objects") return Response.json({ data: [object] });
      if (path.startsWith("/api/records/scoped_records?"))
        return Response.json({
          data: [{ id: "1", displayName: "Savia", shortName: "SV" }],
          total: 1,
        });
      return Response.json({ data: [] });
    });
    setStudioRuntime({ embedded: true, tenantId: 24, transport });
    render(<Root embedded search="object=scoped_records&view=records" />);
    expect(await screen.findByText("SV")).toBeVisible();

    const button = screen.queryByRole("button", { name: "Exportar a CSV" });
    if (fields.length === 0) {
      expect(button).toBeNull();
      return;
    }
    expect(button).toBeVisible();
    fireEvent.click(button!);
    const request = transport.mock.calls.find(([path]) =>
      path.startsWith("/api/export/scoped_records?"),
    )?.[0];
    expect(request).toBeDefined();
    expect(
      new URL(request!, "https://savia.test").searchParams.get("columns"),
    ).toBe(JSON.stringify(fields));
  },
);

it("keeps the trash action compact while preserving its accessible name", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({ data: [], total: 0 });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const trash = await screen.findByRole("button", { name: "Papelera" });
  expect(trash).not.toHaveTextContent("Papelera");
});

it.each([false, true])(
  "uses server trash only with scoped restore access (%s)",
  async (restore) => {
    const object = {
      ...agencyProfiles,
      config: {
        ...agencyProfiles.config,
        studio: {
          capabilities: {
            list: true,
            read: true,
            create: false,
            update: false,
            delete: false,
            restore,
            schema: false,
            customFields: false,
          },
        },
      },
    };
    const archived = {
      id: "archived",
      displayName: "Agencia archivada",
      _version: 2,
      deleted_at: "2026-11-27T00:00:00Z",
    };
    const store = await openLocalStore(crypto.randomUUID());
    let trashRecords = [archived];
    const network = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/objects") return Response.json({ data: [object] });
      if (path.startsWith("/api/records/agency_profiles?"))
        return Response.json({
          data: trashRecords,
          total: trashRecords.length,
        });
      if (
        path === "/api/records/agency_profiles/archived/restore" &&
        init?.method === "POST"
      ) {
        expect(JSON.parse(String(init.body))).toEqual({ version: 2 });
        trashRecords = [];
        return Response.json({
          data: { ...archived, _version: 3, deleted_at: null },
        });
      }
      return Response.json({ data: [] });
    });
    const sync = vi.fn(async () => {});
    try {
      await store.refreshManifest([
        {
          name: object.name,
          object,
          capability: "read-only",
          schemaVersion: 1,
        },
      ]);
      await store.applyPull(object.name, {
        documents: [],
        hasMore: false,
        cursor: "initial",
      });
      setStudioRuntime({
        embedded: true,
        tenantId: 0,
        transport: createLocalTransport(store, network, sync),
      });
      render(<Root embedded search="object=agency_profiles&view=records" />);
      await screen.findByText("No hay registros para mostrar");
      if (!restore) {
        expect(
          screen.queryByRole("button", { name: "Papelera" }),
        ).not.toBeInTheDocument();
        expect(
          network.mock.calls.some(([path]) => path.startsWith("/api/records/")),
        ).toBe(false);
        return;
      }
      fireEvent.click(screen.getByRole("button", { name: "Papelera" }));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Restaurar Agencia archivada",
        }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Restaurar Agencia archivada",
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Restaurar" }),
      );
      await screen.findByText("No hay registros para mostrar");
      expect(
        network.mock.calls.find(([path]) => path.includes("trash=true"))?.[1]
          ?.cache,
      ).toBe("no-store");
      expect(sync).toHaveBeenCalledWith(object.name, true);
      expect(await store.get(object.name, archived.id)).toBeUndefined();
    } finally {
      cleanup();
      await store.db.delete();
    }
  },
);

it.each([false, true])(
  "offers trash for bulk deletion of native records (scoped: %s)",
  async (scoped) => {
    const object = scoped
      ? {
          ...agencyProfiles,
          config: {
            ...agencyProfiles.config,
            studio: {
              capabilities: {
                list: true,
                read: true,
                create: false,
                update: false,
                delete: true,
                schema: false,
                customFields: false,
              },
            },
          },
        }
      : agencyProfiles;
    const transport = vi.fn(async (path: string) => {
      if (path === "/api/objects") return Response.json({ data: [object] });
      if (path === "/api/views/agency_profiles")
        return Response.json({ data: [], default: null });
      if (path.startsWith("/api/records/agency_profiles"))
        return Response.json({
          data: [
            {
              id: "agency-1",
              displayName: "Savia",
              shortName: "SV",
              email: "hola@savia.test",
              internalId: "profile-1",
            },
          ],
          total: 1,
        });
      return Response.json({ data: {} });
    });
    setStudioRuntime({
      embedded: true,
      tenantId: 0,
      businessSetupEnabled: false,
      transport,
    });

    render(<Root embedded search="object=agency_profiles&view=records" />);

    const records = await screen.findByRole("region", {
      name: "Registros de Perfiles de agencia",
    });
    expect(within(records).getAllByRole("checkbox")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Eliminar seleccionados" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(records).getAllByRole("checkbox")[0]);
    fireEvent.click(
      screen.getByRole("button", { name: "Eliminar seleccionados" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Eliminar registro",
    });
    expect(
      within(dialog).getByRole("button", { name: "Mover a papelera" }),
    ).toBeVisible();
  },
);

it("reveals directional controls for an overflowing records table", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const records = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  const viewport = records.querySelector(
    '[data-slot="table-container"]',
  ) as HTMLDivElement;
  const scrollBy = vi.fn();
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 480 },
    scrollLeft: { configurable: true, value: 0, writable: true },
    scrollWidth: { configurable: true, value: 1200 },
    scrollBy: { configurable: true, value: scrollBy },
  });

  fireEvent(window, new Event("resize"));

  const next = await screen.findByRole("button", {
    name: "Ver columnas a la derecha",
  });
  fireEvent.click(next);
  expect(scrollBy).toHaveBeenCalledWith({ left: 384, behavior: "smooth" });

  viewport.scrollLeft = 384;
  fireEvent.scroll(viewport);
  expect(
    await screen.findByRole("button", { name: "Ver columnas a la izquierda" }),
  ).toBeVisible();
});

it("explains how to recover after hiding every table column", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({ data: [], total: 0 });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Configurar vista" }),
  );
  const panel = screen.getByRole("dialog", { name: "Configurar vista" });
  fireEvent.click(
    within(panel).getByRole("button", { name: "Ocultar todas las columnas" }),
  );
  fireEvent.click(
    within(panel).getByRole("button", { name: "Cerrar configuración" }),
  );

  expect(await screen.findByText("No hay columnas visibles")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Configurar columnas" }),
  ).toBeVisible();
});

it("exposes server-backed table filters for agency profiles", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);
  fireEvent.click(await screen.findByRole("button", { name: "Filtros" }));
  fireEvent.click(screen.getByRole("button", { name: "Añadir filtro" }));
  expect(
    screen.getByRole("combobox", { name: "Campo del filtro 1" }),
  ).toBeVisible();
  expect(
    screen.getByRole("combobox", { name: "Operador del filtro 1" }),
  ).toHaveTextContent("Contiene");
  fireEvent.change(
    screen.getByRole("textbox", { name: "Valor del filtro 1" }),
    {
      target: { value: "Agen" },
    },
  );
  const recordRequests = () =>
    transport.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.includes("/api/records/agency_profiles"));
  expect(
    recordRequests().some((path) => decodeURIComponent(path).includes("Agen")),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
  await waitFor(() =>
    expect(
      recordRequests().some((path) =>
        decodeURIComponent(path).includes("Agen"),
      ),
    ).toBe(true),
  );
});

it("lists custom views and deletes them from the configuration drawer", async () => {
  let savedViews = [
    {
      id: "view-test",
      name: "Test",
      config: {
        columns: ["displayName", "shortName"],
        columnOrder: ["displayName", "shortName"],
        columnAliases: {},
      },
    },
  ];
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles" && init?.method !== "DELETE")
      return Response.json({ data: savedViews, default: null });
    if (
      path === "/api/views/agency_profiles/view-test" &&
      init?.method === "DELETE"
    ) {
      savedViews = [];
      return Response.json({ data: { id: "view-test", deleted: true } });
    }
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);
  expect(await screen.findByRole("button", { name: "Test" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Configurar vista" }));

  const panel = screen.getByRole("dialog", { name: "Configurar vista" });
  expect(
    within(panel).getByRole("heading", { name: "Mis vistas" }),
  ).toBeVisible();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Eliminar vista Test" }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Eliminar vista Test",
  });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Eliminar" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Test" }),
    ).not.toBeInTheDocument(),
  );
});

it("opens a searchable table-column panel and restores the default selection", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [] });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  fireEvent.click(
    await screen.findByRole("button", { name: "Configurar vista" }),
  );

  const panel = screen.getByRole("dialog", { name: "Configurar vista" });
  expect(within(panel).getByText("4 de 4 columnas visibles")).toBeVisible();
  expect(
    within(panel).getByRole("searchbox", { name: "Buscar columna" }),
  ).toBeVisible();
  expect(
    within(panel).getByRole("button", { name: "Restablecer columnas" }),
  ).toBeVisible();
  const hideAll = within(panel).getByRole("button", {
    name: "Ocultar todas las columnas",
  });
  fireEvent.click(hideAll);
  expect(within(panel).getByText("0 de 4 columnas visibles")).toBeVisible();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Mostrar todas las columnas" }),
  );
  expect(within(panel).getByText("4 de 4 columnas visibles")).toBeVisible();
  expect(
    within(panel).getByRole("list", { name: "Columnas de la tabla" }),
  ).toBeVisible();

  fireEvent.change(
    within(panel).getByRole("searchbox", { name: "Buscar columna" }),
    { target: { value: "email" } },
  );
  expect(
    within(panel).getByRole("listitem", {
      name: "Campo channels · email",
    }),
  ).toBeVisible();
  expect(
    within(panel).queryByRole("listitem", {
      name: "Campo organization · displayName",
    }),
  ).not.toBeInTheDocument();

  const emailColumn = within(panel).getByRole("listitem", {
    name: "Campo channels · email",
  });
  expect(within(emailColumn).getByText("Visible")).toBeVisible();
  const emailVisibility = within(emailColumn).getByRole("switch", {
    name: "Visible channels · email",
  });
  expect(emailVisibility).toHaveAttribute("aria-checked", "true");
  fireEvent.click(emailVisibility);
  expect(emailVisibility).toHaveAttribute("aria-checked", "false");
  expect(within(emailColumn).getByText("Oculta")).toBeVisible();
  expect(within(panel).getByText("3 de 4 columnas visibles")).toBeVisible();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Restablecer columnas" }),
  );
  expect(within(emailColumn).getByText("Visible")).toBeVisible();
  expect(within(panel).getByText("4 de 4 columnas visibles")).toBeVisible();
});

it("applies aliases, visibility and drag order to the current table only", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [] });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  fireEvent.click(
    await screen.findByRole("button", { name: "Configurar vista" }),
  );

  const panel = screen.getByRole("dialog", { name: "Configurar vista" });
  fireEvent.change(
    within(panel).getByRole("textbox", {
      name: "Alias de organization · displayName",
    }),
    { target: { value: "Nombre de agencia" } },
  );

  const source = within(panel).getByRole("listitem", {
    name: "Campo organization · shortName",
  });
  const target = within(panel).getByRole("listitem", {
    name: "Campo organization · displayName",
  });
  expect(source).not.toHaveAttribute("draggable");
  fireEvent.dragStart(
    within(source).getByRole("button", { name: /Reordenar/ }),
  );
  fireEvent.dragOver(target);
  fireEvent.drop(target);

  fireEvent.click(
    within(panel).getByRole("switch", {
      name: "Visible organization · shortName",
    }),
  );

  expect(
    within(panel)
      .getAllByRole("listitem")
      .slice(0, 2)
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual([
    "Campo organization · shortName",
    "Campo organization · displayName",
  ]);

  fireEvent.click(
    within(panel).getByRole("button", { name: "Cerrar configuración" }),
  );

  const records = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  expect(
    within(records).getByRole("columnheader", { name: "Nombre de agencia" }),
  ).toBeVisible();
  expect(
    within(records).queryByRole("columnheader", {
      name: "organization · shortName",
    }),
  ).not.toBeInTheDocument();
});

it("saves table aliases and restores them after reopening the records view", async () => {
  let defaultConfig: Record<string, unknown> | null = null;
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({
        data: [],
        default: defaultConfig ? { config: defaultConfig } : null,
      });
    if (
      path === "/api/views/agency_profiles/default" &&
      init?.method === "PUT"
    ) {
      defaultConfig = JSON.parse(String(init.body)).config;
      return Response.json({ data: { config: defaultConfig } });
    }
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  const first = render(
    <Root embedded search="object=agency_profiles&view=records" />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Configurar vista" }),
  );
  const panel = screen.getByRole("dialog", { name: "Configurar vista" });
  const save = within(panel).getByRole("button", { name: "Guardar cambios" });
  expect(save).toBeDisabled();
  fireEvent.change(
    within(panel).getByRole("textbox", {
      name: "Alias de organization · displayName",
    }),
    { target: { value: "Nombre de agencia" } },
  );
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() =>
    expect(defaultConfig).toMatchObject({
      columnAliases: { displayName: "Nombre de agencia" },
    }),
  );

  first.unmount();
  render(<Root embedded search="object=agency_profiles&view=records" />);
  const records = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  await waitFor(() =>
    expect(
      within(records).getByRole("columnheader", {
        name: "Nombre de agencia",
      }),
    ).toBeVisible(),
  );
});

it("shows a per-row delete action for collections that allow deletion", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
            _version: 1,
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const records = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  expect(
    within(records).getByRole("button", { name: "Eliminar Savia" }),
  ).toBeVisible();
});

it("hides per-row delete when the collection does not allow deletion", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
            _version: 1,
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const records = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  expect(
    within(records).queryByRole("button", { name: /Eliminar/ }),
  ).not.toBeInTheDocument();
});

it("deletes a record from the row action after confirmation", async () => {
  let records = [
    {
      id: "agency-1",
      displayName: "Savia",
      shortName: "SV",
      email: "hola@savia.test",
      internalId: "profile-1",
      _version: 1,
    },
  ];
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (
      path === "/api/records/agency_profiles/agency-1?version=1" &&
      init?.method === "DELETE"
    ) {
      records = [];
      return Response.json({ data: { id: "agency-1", deleted: true } });
    }
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({ data: records, total: records.length });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const recordsRegion = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  fireEvent.click(
    within(recordsRegion).getByRole("button", { name: "Eliminar Savia" }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Eliminar Savia",
  });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Mover a papelera" }),
  );
  await waitFor(() =>
    expect(
      transport.mock.calls.some(
        ([path, init]) =>
          path === "/api/records/agency_profiles/agency-1?version=1" &&
          init?.method === "DELETE",
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(within(recordsRegion).queryByText("Savia")).not.toBeInTheDocument(),
  );
});

it.each([
  "complete",
  "partial",
  "missing version",
  "version denied",
  "workspace changed",
])("reconciles a bulk deletion when the outcome is %s", async (scenario) => {
  const partial = scenario === "partial";
  const missingVersion = scenario === "missing version";
  const versionDenied = scenario === "version denied";
  const switchesWorkspace = scenario === "workspace changed";
  let records = [
    {
      id: "agency-1",
      displayName: "Savia",
      shortName: "SV",
      email: "hola@savia.test",
      internalId: "profile-1",
      _version: 1,
    },
    {
      id: "agency-2",
      displayName: "Norte",
      shortName: "NR",
      email: "norte@savia.test",
      internalId: "profile-2",
      _version:
        switchesWorkspace || missingVersion || versionDenied ? undefined : 2,
    },
  ];
  const submitted: Array<Array<{ id: string; version: number }>> = [];
  let supplyVersion!: () => void;
  const versionLookup = new Promise<void>((resolve) => {
    supplyVersion = resolve;
  });
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path === "/api/records/agency_profiles/agency-2" && missingVersion)
      return Response.json({ error: "Record not found" }, { status: 404 });
    if (path === "/api/records/agency_profiles/agency-2" && versionDenied)
      return Response.json({ error: "Access denied" }, { status: 403 });
    if (path === "/api/records/agency_profiles/agency-2" && switchesWorkspace) {
      await versionLookup;
      return Response.json({ data: { ...records[1], _version: 2 } });
    }
    if (
      path === "/api/records/agency_profiles/bulk" &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        action: string;
        records: Array<{ id: string; version: number }>;
      };
      expect(body.action).toBe("delete");
      submitted.push(body.records);
      const conflict = partial && submitted.length === 1;
      const outcomes = body.records.map(({ id }) =>
        conflict && id === "agency-2"
          ? { id, ok: false, error: "El registro cambió" }
          : { id, ok: true },
      );
      records = records
        .filter(
          (record) => !outcomes.some((row) => row.ok && row.id === record.id),
        )
        .map((record) => (conflict ? { ...record, _version: 3 } : record));
      return Response.json({ data: outcomes });
    }
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({ data: records, total: records.length });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const recordsRegion = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  const rowCheckboxes = within(recordsRegion).getAllByRole("checkbox");
  fireEvent.click(rowCheckboxes[1]);
  fireEvent.click(rowCheckboxes[2]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Eliminar seleccionados" }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Eliminar 2 registros",
  });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Mover a papelera" }),
  );
  if (versionDenied) {
    await waitFor(() =>
      expect(
        transport.mock.calls.some(
          ([path]) => path === "/api/records/agency_profiles/agency-2",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(confirmation).getByRole("button", { name: "Mover a papelera" }),
      ).toBeEnabled(),
    );
    expect(submitted).toHaveLength(0);
    return;
  }
  if (switchesWorkspace) {
    await waitFor(() =>
      expect(
        transport.mock.calls.some(
          ([path]) => path === "/api/records/agency_profiles/agency-2",
        ),
      ).toBe(true),
    );
    const next = vi.fn(async (_path: string, _init?: RequestInit) =>
      Response.json({ data: [] }),
    );
    setStudioRuntime({ ...getStudioRuntime(), transport: next });
    await act(async () => supplyVersion());
    await waitFor(() =>
      expect(
        within(confirmation).getByRole("button", {
          name: "Mover a papelera",
        }),
      ).toBeEnabled(),
    );
    expect(submitted).toHaveLength(0);
    expect(
      next.mock.calls.some(
        ([path, init]) => path.endsWith("/bulk") && init?.method === "POST",
      ),
    ).toBe(false);
    return;
  }
  await waitFor(() =>
    expect(
      transport.mock.calls.some(
        ([path, init]) =>
          path === "/api/records/agency_profiles/bulk" &&
          init?.method === "POST",
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(within(recordsRegion).queryByText("Savia")).not.toBeInTheDocument(),
  );
  expect(submitted[0]).toEqual(
    missingVersion
      ? [{ id: "agency-1", version: 1 }]
      : [
          { id: "agency-1", version: 1 },
          { id: "agency-2", version: 2 },
        ],
  );
  if (missingVersion) {
    expect(
      within(within(recordsRegion).getByText("Norte").closest("tr")!).getByRole(
        "checkbox",
      ),
    ).toBeChecked();
    return;
  }
  if (partial) {
    const failedRow = within(recordsRegion).getByText("Norte").closest("tr")!;
    expect(within(failedRow).getByRole("checkbox")).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Eliminar seleccionados" }),
    );
    const retry = await screen.findByRole("dialog", {
      name: "Eliminar registro",
    });
    fireEvent.click(
      within(retry).getByRole("button", { name: "Mover a papelera" }),
    );
    await waitFor(() =>
      expect(
        within(recordsRegion).queryByText("Norte"),
      ).not.toBeInTheDocument(),
    );
    expect(submitted[1]).toEqual([{ id: "agency-2", version: 3 }]);
  }
  expect(within(recordsRegion).queryByText("Norte")).not.toBeInTheDocument();
});

it.each(["complete", "read fails", "view changes"])(
  "selects every matching page before updating the selection (%s)",
  async (scenario) => {
    const filter = {
      logic: "and",
      conditions: [{ field: "shortName", op: "eq", value: "match" }],
    };
    const matching = Array.from({ length: 201 }, (_, offset) => ({
      id: `agency-${offset + 1}`,
      displayName: `Agency ${offset + 1}`,
      shortName: "match",
      _version: 1,
    }));
    const unfiltered = [
      { id: "outside", displayName: "Other agency", shortName: "other" },
      ...matching,
    ];
    const interrupted = scenario === "read fails";
    let failNextPage = interrupted;
    const blockedPage = Promise.withResolvers<void>();
    let pendingPageSignal: AbortSignal | null | undefined;
    const selectionQueries: URLSearchParams[] = [];
    const transport = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/objects")
        return Response.json({ data: [agencyProfiles] });
      if (path === "/api/views/agency_profiles")
        return Response.json({
          data: [
            {
              id: "matches",
              name: "Coincidencias",
              config: { filters: filter },
            },
          ],
          default: null,
        });
      if (path.startsWith("/api/records/agency_profiles?")) {
        const query = new URLSearchParams(path.split("?", 2)[1]);
        const page = Number(query.get("page"));
        const requested = Number(query.get("perPage"));
        const perPage = Math.min(200, requested);
        if (requested > 25) selectionQueries.push(query);
        if (page === 2 && failNextPage) {
          failNextPage = false;
          return Response.json({ error: "Temporary error" }, { status: 503 });
        }
        if (page === 2 && scenario === "view changes") {
          pendingPageSignal = init?.signal;
          await blockedPage.promise;
        }
        const source =
          query.get("filters") === JSON.stringify(filter)
            ? matching
            : unfiltered;
        return Response.json({
          data: source.slice((page - 1) * perPage, page * perPage),
          total: source.length,
        });
      }
      return Response.json({ data: [] });
    });
    setStudioRuntime({ embedded: true, tenantId: 0, transport });
    render(<Root embedded search="object=agency_profiles&view=records" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Coincidencias" }),
    );
    await screen.findByText("1-25 de 201");
    const table = screen.getByRole("region", {
      name: "Registros de Perfiles de agencia",
    });
    fireEvent.click(within(table).getAllByRole("checkbox")[0]);
    const selectAll = screen.getByRole("button", { name: "Seleccionar todo" });
    const notify = vi.spyOn(toast, "error");
    try {
      fireEvent.click(selectAll);
      if (scenario === "view changes") {
        await waitFor(() => expect(pendingPageSignal?.aborted).toBe(false));
        fireEvent.click(
          screen.getByRole("button", { name: "Todos los registros" }),
        );
        await screen.findByText("1-25 de 202");
        expect(pendingPageSignal?.aborted).toBe(true);
        await act(async () => blockedPage.resolve());
        expect(screen.getByText("25 elementos seleccionados")).toBeVisible();
        expect(selectionQueries).toHaveLength(2);
        expect(notify).not.toHaveBeenCalled();
        return;
      }
      if (interrupted) {
        await waitFor(() =>
          expect(notify).toHaveBeenCalledWith(
            "No se pudieron seleccionar todos los registros. Reintenta.",
          ),
        );
        expect(screen.getByText("25 elementos seleccionados")).toBeVisible();
        fireEvent.click(selectAll);
      }
      expect(
        await screen.findByText("201 elementos seleccionados"),
      ).toBeVisible();
      expect(
        selectionQueries.map((query) => Number(query.get("page"))),
      ).toEqual(interrupted ? [1, 2, 1, 2, 3] : [1, 2, 3]);
      expect(
        selectionQueries.every(
          (query) => query.get("filters") === JSON.stringify(filter),
        ),
      ).toBe(true);
    } finally {
      blockedPage.resolve();
      notify.mockRestore();
    }
  },
);

it("deletes selections above one server batch and keeps unconfirmed rows after a later request fails", async () => {
  const client = createStudioQueryClient();
  let records = Array.from({ length: 201 }, (_, offset) => ({
    id: `agency-${offset + 1}`,
    displayName: `Agency ${offset + 1}`,
    _version: 1,
  }));
  const submissions: Array<Array<{ id: string; version: number }>> = [];
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/objects")
      return Response.json({ data: [agencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (
      path === "/api/records/agency_profiles/bulk" &&
      init?.method === "POST"
    ) {
      const batch = JSON.parse(String(init.body))
        .records as (typeof submissions)[number];
      submissions.push(batch);
      if (batch.length > 200)
        return Response.json(
          { error: "Batch exceeds 200 records" },
          { status: 422 },
        );
      if (submissions.length === 2)
        return Response.json(
          { error: "Interrupted before confirmation" },
          { status: 503 },
        );
      const ids = new Set(batch.map(({ id }) => id));
      records = records.filter(({ id }) => !ids.has(id));
      if (submissions.length === 1)
        await client.invalidateQueries({
          queryKey: ["agency_profiles", "getList"],
        });
      return Response.json({ data: batch.map(({ id }) => ({ id, ok: true })) });
    }
    if (path.startsWith("/api/records/agency_profiles/"))
      return Response.json({
        data: records.find(({ id }) => id === path.split("/").at(-1)),
      });
    if (path.startsWith("/api/records/agency_profiles?")) {
      const params = new URLSearchParams(path.split("?", 2)[1]);
      const perPage = Math.min(200, Number(params.get("perPage")) || 25);
      const offset = (Number(params.get("page")) - 1) * perPage;
      return Response.json({
        data: records.slice(offset, offset + perPage),
        total: records.length,
      });
    }
    return Response.json({ data: [] });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });
  render(
    <Root
      embedded
      search="object=agency_profiles&view=records"
      queryClient={client}
    />,
  );
  const table = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  for (let page = 0; page < 9; page++) {
    if (page > 0)
      fireEvent.click(
        within(table).getByRole("link", { name: "Página siguiente" }),
      );
    const range = `${page * 25 + 1}-${Math.min((page + 1) * 25, 201)} de 201`;
    await waitFor(() => {
      expect(table.closest("[aria-busy]")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      expect(
        within(table).getByText(range, { exact: true }),
      ).toBeInTheDocument();
    });
    fireEvent.click(within(table).getAllByRole("checkbox")[0]);
  }
  fireEvent.click(
    screen.getByRole("button", { name: "Eliminar seleccionados" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveAccessibleName("Eliminar 201 registros");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Mover a papelera" }),
  );
  await waitFor(() =>
    expect(submissions.map((batch) => batch.length)).toEqual([200, 1]),
  );
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await screen.findByText("1-1 de 1");
  fireEvent.click(
    screen.getByRole("button", { name: "Eliminar seleccionados" }),
  );
  const retry = await screen.findByRole("dialog", {
    name: "Eliminar registro",
  });
  fireEvent.click(
    within(retry).getByRole("button", { name: "Mover a papelera" }),
  );
  await waitFor(() => expect(submissions).toHaveLength(3));
  expect(submissions[2]).toEqual([{ id: "agency-201", version: 1 }]);
});

it("offers individual HubSpot archive without a bulk selection", async () => {
  const collection = hubspotContacts.config.studio.collection;
  const object = {
    ...hubspotContacts,
    config: {
      ...hubspotContacts.config,
      studio: {
        collection: {
          ...collection,
          capabilities: { ...collection.capabilities, delete: true },
        },
      },
    },
  };
  let contacts = [{ id: "hubspot-1", firstname: "Test contact" }];
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/objects") return Response.json({ data: [object] });
    if (path.startsWith("/api/records/hubspot_contacts?"))
      return Response.json({ data: contacts, total: contacts.length });
    if (
      path === "/api/records/hubspot_contacts/hubspot-1?version=local" &&
      init?.method === "DELETE"
    ) {
      contacts = [];
      return Response.json({ data: { id: "hubspot-1", deleted: true } });
    }
    return Response.json({ data: [] });
  });
  setStudioRuntime({ embedded: true, tenantId: 0, transport });
  render(<Root embedded search="object=hubspot_contacts&view=records" />);
  const recordsRegion = await screen.findByRole("region", {
    name: "Registros de Contactos",
  });
  expect(within(recordsRegion).queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.click(
    within(recordsRegion).getByRole("button", { name: "Eliminar hubspot-1" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Eliminar hubspot-1",
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Archivar en HubSpot" }),
  );
  await waitFor(() =>
    expect(
      transport.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toEqual([
      [
        "/api/records/hubspot_contacts/hubspot-1?version=local",
        expect.objectContaining({ method: "DELETE" }),
      ],
    ]),
  );
  await waitFor(() =>
    expect(screen.queryByText("Test contact")).not.toBeInTheDocument(),
  );
  expect(transport.mock.calls.some(([path]) => path.endsWith("/bulk"))).toBe(
    false,
  );
});

it("does not offer bulk delete for collections without delete capability", async () => {
  const transport = vi.fn(async (path: string) => {
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
            _version: 1,
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);

  const recordsRegion = await screen.findByRole("region", {
    name: "Registros de Perfiles de agencia",
  });
  expect(within(recordsRegion).queryByRole("checkbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Eliminar seleccionados" }),
  ).not.toBeInTheDocument();
});

it("saves source-form column layout from the records configuration drawer", async () => {
  let savedObject: Record<string, unknown> | null = null;
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/collection-catalog") return Response.json({ data: [] });
    if (path === "/api/objects")
      return Response.json({ data: [sourceAgencyProfiles] });
    if (path === "/api/objects/agency_profiles" && init?.method === "PUT") {
      savedObject = JSON.parse(String(init.body));
      return Response.json({ data: savedObject });
    }
    if (path === "/api/views/agency_profiles")
      return Response.json({ data: [], default: null });
    if (path.startsWith("/api/records/agency_profiles"))
      return Response.json({
        data: [
          {
            id: "agency-1",
            displayName: "Savia",
            shortName: "SV",
            email: "hola@savia.test",
            internalId: "profile-1",
          },
        ],
        total: 1,
      });
    return Response.json({ data: {} });
  });
  setStudioRuntime({
    embedded: true,
    tenantId: 0,
    businessSetupEnabled: false,
    transport,
  });

  render(<Root embedded search="object=agency_profiles&view=records" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Configurar vista" }),
  );
  const panel = screen.getByRole("dialog", { name: "Configurar vista" });
  fireEvent.click(within(panel).getByRole("tab", { name: "Formulario" }));
  expect(
    within(panel).queryByRole("combobox", {
      name: "Columnas del formulario",
    }),
  ).not.toBeInTheDocument();
  const oneColumn = await within(panel).findByRole("radio", {
    name: "Una columna",
  });
  const twoColumns = within(panel).getByRole("radio", {
    name: "Dos columnas",
  });
  expect(oneColumn).toBeChecked();
  expect(within(panel).getByTestId("form-layout-preview-1")).toBeVisible();
  expect(within(panel).getByTestId("form-layout-preview-2")).toBeVisible();
  fireEvent.click(twoColumns);
  expect(twoColumns).toBeChecked();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Guardar cambios" }),
  );
  await waitFor(() =>
    expect(savedObject).toMatchObject({
      config: { studio: { columns: 2 } },
    }),
  );
});
