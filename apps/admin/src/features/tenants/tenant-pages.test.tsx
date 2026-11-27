// @vitest-environment-options {"url":"https://savia-preview.hefesoft.com/"}
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import type { AppServices } from "@/app-services";
import { ApiClientError } from "@/api/api-client";
import { invalidateTenantWorkspaces } from "@/api/tenant-workspaces-client";

const originalElementScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

const tenant = {
  id: 101,
  name: "Comunidad",
  idSlug: "comunidad",
  isActive: true,
  agencyId: null,
  createdAt: "2026-09-09",
  updatedAt: "2026-09-09",
  kind: "commercial" as const,
};
const platformTenant = {
  id: 0,
  name: "Plataforma Savia",
  idSlug: "savia-platform",
  isActive: true,
  agencyId: null,
  createdAt: "2026-09-09",
  updatedAt: "2026-09-09",
  kind: "platform" as const,
};
function services() {
  return {
    authSession: {
      checkSession: vi.fn(),
      getPermissions: vi
        .fn()
        .mockResolvedValue({ memberships: [], canManageIdentity: true }),
      getIdentity: vi.fn(),
    },
    authProvider: {
      checkAuth: vi.fn().mockResolvedValue(undefined),
      checkError: vi.fn(),
      getIdentity: vi
        .fn()
        .mockResolvedValue({ id: "admin", fullName: "Admin" }),
      getPermissions: vi
        .fn()
        .mockResolvedValue({ memberships: [], canManageIdentity: true }),
      canAccess: vi.fn().mockResolvedValue(true),
      login: vi.fn(),
      logout: vi.fn(),
    },
    dataProvider: {
      getList: vi.fn().mockImplementation((resource) =>
        Promise.resolve({
          data: resource === "tenants" ? [tenant] : [],
          total: resource === "tenants" ? 1 : 0,
        }),
      ),
      getOne: vi.fn().mockImplementation((_resource, params) =>
        Promise.resolve({
          data: Number(params.id) === 0 ? platformTenant : tenant,
        }),
      ),
      getMany: vi.fn().mockResolvedValue({ data: [] }),
      getManyReference: vi.fn(),
      create: vi
        .fn()
        .mockImplementation((_resource, params) =>
          Promise.resolve({ data: { ...tenant, ...params.data } }),
        ),
      update: vi.fn().mockImplementation((_resource, params) =>
        Promise.resolve({
          data: { ...tenant, ...params.previousData, ...params.data },
        }),
      ),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    domains: { list: vi.fn().mockResolvedValue([]) },
    commands: { execute: vi.fn() },
    assistantConfiguration: {
      summary: vi.fn().mockResolvedValue({ global: null, tenants: [] }),
      models: vi.fn().mockResolvedValue([]),
      activeTenant: vi.fn().mockResolvedValue({ tenants: [] }),
    },
  } as unknown as AppServices;
}
async function renderApp(appServices: AppServices) {
  // Flush the immediately resolved session and list-query effects before
  // starting an assertion timeout for the resulting page.
  await act(async () => {
    render(<App services={appServices} />);
  });
}
function open(path: string) {
  window.history.replaceState({}, "", "/");
  window.location.hash = `#${path}`;
}
beforeEach(() => {
  invalidateTenantWorkspaces();
  // React Admin resets browser scroll on navigation. jsdom has no viewport scroll.
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path !== "/api/public/tenant-branding")
      throw new Error(`Unexpected tenant-page request: ${path}`);
    return new Response(JSON.stringify({ data: null }), {
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  invalidateTenantWorkspaces();
  if (originalElementScrollTo) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTo",
      originalElementScrollTo,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

describe("generic tenant pages", () => {
  it("transfers an assigned user without offering membership removal", async () => {
    open("/users/principal-one");
    const appServices = services();
    const record = {
      id: "principal-one",
      displayName: "Persona Uno",
      firstName: "Persona",
      lastName: "Uno",
      email: "person@example.test",
      platformAdmin: false,
      isActive: true,
      isBanned: false,
      twoFactorEnabled: false,
      memberships: [
        {
          id: "membership-one",
          tenantId: 101,
          agencyId: 101,
          role: "tenant_admin",
          isActive: true,
        },
      ],
    };
    vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
      data: record,
    });
    vi.mocked(appServices.dataProvider.getList).mockResolvedValue({
      data: [tenant, { ...tenant, id: 102, name: "Destino" }],
      total: 2,
    });
    await renderApp(appServices);
    expect(await screen.findByText("Organización #101")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Quitar" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Transferir usuario" }),
    ).toBeVisible();
  });

  it("requires choosing the destination when the only available tenant differs from the assignment", async () => {
    open("/users/principal-one");
    const appServices = services();
    vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
      data: {
        id: "principal-one",
        displayName: "Persona Uno",
        firstName: "Persona",
        lastName: "Uno",
        email: "person@example.test",
        platformAdmin: false,
        isActive: true,
        memberships: [
          {
            id: "membership-one",
            tenantId: 101,
            role: "viewer",
            isActive: true,
          },
        ],
      },
    });
    vi.mocked(appServices.dataProvider.getList).mockResolvedValue({
      data: [{ ...tenant, id: 102, name: "Destino" }],
      total: 1,
    });
    const grantMembership = vi.fn().mockResolvedValue(undefined);
    Object.assign(appServices.dataProvider, { grantMembership });
    const user = userEvent.setup();
    await renderApp(appServices);
    await user.click(await screen.findByRole("tab", { name: /asignad/i }));

    const transfer = screen.getByRole("button", { name: "Transferir usuario" });
    expect(transfer).toBeDisabled();
    expect(grantMembership).not.toHaveBeenCalled();
    const destination = screen.getByRole("combobox", { name: "Tenant" });
    await user.click(destination);
    await user.click(await screen.findByRole("option", { name: "Destino" }));
    await user.click(transfer);
    expect(grantMembership).toHaveBeenCalledWith("principal-one", {
      tenantId: 102,
      role: "viewer",
    });
  });

  it("finds a transfer destination after the first 100 tenants by its URL identifier", async () => {
    open("/users/principal-one");
    const appServices = services();
    vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
      data: {
        id: "principal-one",
        displayName: "Persona Uno",
        firstName: "Persona",
        lastName: "Uno",
        email: "person@example.test",
        platformAdmin: false,
        isActive: true,
        memberships: [
          {
            id: "membership-one",
            tenantId: 101,
            role: "viewer",
            isActive: true,
          },
        ],
      },
    });
    const catalog = [
      ...Array.from({ length: 100 }, (_, index) => ({
        ...tenant,
        id: 101 + index,
        name: `Tenant ${index + 1}`,
        idSlug: `tenant-${index + 1}`,
      })),
      { ...tenant, id: 201, name: "Norte", idSlug: "zona-norte" },
      {
        ...tenant,
        id: 202,
        name: "Norte inactivo",
        idSlug: "zona-norte-inactiva",
        isActive: false,
      },
    ];
    vi.mocked(appServices.dataProvider.getList).mockImplementation(
      async (resource, params) => {
        if (resource !== "tenants") return { data: [], total: 0 };
        const eligible =
          params.filter?.isActive === true
            ? catalog.filter((item) => item.isActive)
            : catalog;
        return {
          data: eligible.slice(0, params.pagination?.perPage),
          total: eligible.length,
        };
      },
    );
    const grantMembership = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError(
          409,
          "TENANT_ACTIVE_USER_LIMIT_REACHED",
          "Tenant is full.",
        ),
      )
      .mockResolvedValue(undefined);
    Object.assign(appServices.dataProvider, { grantMembership });
    const user = userEvent.setup();
    await renderApp(appServices);
    await user.click(await screen.findByRole("tab", { name: /asignad/i }));
    await user.click(screen.getByRole("combobox", { name: "Tenant" }));
    await user.type(screen.getByRole("combobox", { name: "" }), "zona-norte");
    await user.click(await screen.findByRole("option", { name: "Norte" }));
    await user.click(
      screen.getByRole("button", { name: "Transferir usuario" }),
    );
    expect(grantMembership).toHaveBeenCalledWith("principal-one", {
      tenantId: 201,
      role: "viewer",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "El tenant seleccionado alcanzó su límite de usuarios activos.",
    );
    const destination = screen.getByRole("combobox", { name: "Tenant" });
    expect(destination).toHaveTextContent("Norte");
    await user.click(destination);
    await user.type(screen.getByRole("combobox", { name: "" }), "zona-norte");
    expect(
      screen.queryByRole("option", { name: "Norte inactivo" }),
    ).not.toBeInTheDocument();
  });

  it("requires an explicit active tenant when removing platform access", async () => {
    open("/users/principal-one");
    const appServices = services();
    vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
      data: {
        id: "principal-one",
        displayName: "Persona Uno",
        firstName: "Persona",
        lastName: "Uno",
        email: "person@example.test",
        platformAdmin: true,
        isActive: true,
        memberships: [],
      },
    });
    vi.mocked(appServices.dataProvider.getList).mockImplementation(
      async (resource, params) => {
        if (resource !== "tenants") return { data: [], total: 0 };
        if (params.filter.q === "Comunidad")
          return { data: [tenant], total: 1 };
        return {
          data: [{ ...tenant, id: 10, name: "Otra organización" }],
          total: 101,
        };
      },
    );
    let rejectUpdate!: (error: Error) => void;
    vi.mocked(appServices.dataProvider.update).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectUpdate = reject;
        }),
    );
    const user = userEvent.setup();
    await renderApp(appServices);
    await user.click(
      await screen.findByRole("tab", { name: "Acceso de plataforma" }),
    );
    await user.click(
      screen.getByRole("switch", { name: "Administrador de plataforma" }),
    );
    const target = screen.getByRole("combobox", {
      name: /tenant comercial al retirar acceso global/i,
    });
    expect(target).not.toHaveTextContent("Comunidad");
    expect(appServices.dataProvider.getList).toHaveBeenCalledWith(
      "tenants",
      expect.objectContaining({
        filter: { kind: "commercial", isActive: true },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(target).toHaveAttribute("aria-invalid", "true"));
    expect(target).toHaveAccessibleDescription("Requerido");
    const role = screen.getByRole("combobox", {
      name: /rol al retirar acceso global/i,
    });
    expect(role).toHaveAccessibleDescription("Requerido");
    expect(appServices.dataProvider.update).not.toHaveBeenCalled();

    await user.click(target);
    await user.type(screen.getByRole("combobox", { name: "" }), "Comunidad");
    await user.click(await screen.findByRole("option", { name: "Comunidad" }));
    role.focus();
    await user.keyboard("{ArrowDown}");
    const roleOption = await screen.findByRole("option", {
      name: "Solo lectura",
    });
    roleOption.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(appServices.dataProvider.update).toHaveBeenCalledWith(
        "users",
        expect.objectContaining({
          id: "principal-one",
          data: {
            platformAdmin: false,
            tenantId: 101,
            agencyRole: "viewer",
          },
        }),
      ),
    );
    expect(window.location.hash).toBe("#/users/principal-one");
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
    rejectUpdate(
      new ApiClientError(
        409,
        "TENANT_ACTIVE_USER_LIMIT_REACHED",
        "Tenant is full.",
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "El tenant seleccionado alcanzó su límite de usuarios activos.",
    );
    expect(window.location.hash).toBe("#/users/principal-one");
    expect(
      screen.getByRole("combobox", {
        name: /tenant comercial al retirar acceso global/i,
      }),
    ).toHaveTextContent("Comunidad");
    expect(
      screen.getByRole("combobox", { name: /rol al retirar acceso global/i }),
    ).toHaveTextContent("Solo lectura");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(window.location.hash).toBe("#/users"));
    expect(appServices.dataProvider.update).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      platformAdmin: false,
      field: "firstName",
      oldValue: "Persona",
      newValue: "Ana",
    },
    {
      platformAdmin: true,
      field: "lastName",
      oldValue: "Uno",
      newValue: "Ríos",
    },
  ])(
    "only sends the edited $field when renaming a user",
    async ({ platformAdmin, field, oldValue, newValue }) => {
      open("/users/principal-one");
      const appServices = services();
      vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
        data: {
          id: "principal-one",
          displayName: "Persona Uno",
          firstName: "Persona",
          lastName: "Uno",
          email: "person@example.test",
          platformAdmin,
          isActive: true,
          emailVerified: platformAdmin,
          memberships: [],
        },
      });
      const user = userEvent.setup();
      await renderApp(appServices);
      const input = await screen.findByDisplayValue(oldValue);
      await user.clear(input);
      await user.type(input, `  ${newValue}  `);
      await user.click(screen.getByRole("button", { name: "Guardar" }));
      await waitFor(() =>
        expect(appServices.dataProvider.update).toHaveBeenCalledWith(
          "users",
          expect.objectContaining({
            id: "principal-one",
            data: { [field]: newValue },
          }),
        ),
      );
    },
  );

  it("saves an email verification change on a legacy account without a surname", async () => {
    open("/users/principal-one");
    const appServices = services();
    vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
      data: {
        id: "principal-one",
        displayName: "Persona",
        firstName: "Persona",
        lastName: "",
        email: "person@example.test",
        platformAdmin: false,
        isActive: true,
        emailVerified: false,
        memberships: [],
      },
    });
    const user = userEvent.setup();
    await renderApp(appServices);
    const verified = await screen.findByRole("switch", {
      name: "Correo verificado",
    });
    const save = screen.getByRole("button", { name: "Guardar" });
    expect(save).toBeDisabled();
    await act(async () => {
      fireEvent.submit(verified.closest("form")!);
    });
    expect(appServices.dataProvider.update).not.toHaveBeenCalled();

    await user.click(verified);
    await user.click(save);
    await waitFor(() =>
      expect(appServices.dataProvider.update).toHaveBeenCalledWith(
        "users",
        expect.objectContaining({
          id: "principal-one",
          data: { emailVerified: true },
        }),
      ),
    );
  });

  it("keeps the platform provisioning form open when an active tenant reaches capacity", async () => {
    open("/users/create");
    const appServices = services();
    const choices = [
      tenant,
      { ...tenant, id: 102, name: "Destino" },
      { ...tenant, id: 103, name: "Inactivo", isActive: false },
    ];
    vi.mocked(appServices.dataProvider.getList).mockImplementation(
      async (resource, params) => {
        if (resource !== "tenants") return { data: [], total: 0 };
        const data = params.filter?.isActive
          ? choices.filter((choice) => choice.isActive)
          : choices;
        return { data, total: data.length };
      },
    );
    vi.mocked(appServices.dataProvider.create).mockRejectedValueOnce(
      new ApiClientError(
        409,
        "TENANT_ACTIVE_USER_LIMIT_REACHED",
        "Tenant is full.",
      ),
    );
    const user = userEvent.setup();
    await renderApp(appServices);
    await user.type(
      await screen.findByLabelText("Nombres", { exact: false }),
      "Ari",
    );
    await user.type(
      screen.getByLabelText("Apellidos", { exact: false }),
      "Rios",
    );
    await user.type(
      screen.getByRole("textbox", { name: /^Correo/ }),
      "new-user@example.test",
    );
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const tenantChoice = screen.getByRole("combobox", {
      name: /^Tenant comercial/,
    });
    await waitFor(() =>
      expect(tenantChoice).toHaveAttribute("aria-invalid", "true"),
    );
    expect(tenantChoice).toHaveAccessibleDescription("Requerido");
    expect(appServices.dataProvider.create).not.toHaveBeenCalled();
    await user.click(tenantChoice);
    expect(
      await screen.findByRole("option", { name: "Destino" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Inactivo" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Destino" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "El tenant seleccionado alcanzó su límite de usuarios activos.",
    );
    expect(
      screen.getByRole("combobox", { name: /^Tenant comercial/ }),
    ).toHaveTextContent("Destino");
    expect(screen.getByDisplayValue("new-user@example.test")).toBeVisible();
    expect(window.location.hash).toBe("#/users/create");
  });

  it("hides commercial access when provisioning a platform administrator and restores the tenant when switching back", async () => {
    open("/users/create");
    const appServices = services();
    vi.mocked(appServices.dataProvider.getList).mockResolvedValue({
      data: [tenant, { ...tenant, id: 102, name: "Destino" }],
      total: 2,
    });
    const user = userEvent.setup();
    await renderApp(appServices);
    await user.type(
      await screen.findByLabelText("Nombres", { exact: false }),
      "Ari",
    );
    await user.type(
      screen.getByLabelText("Apellidos", { exact: false }),
      "Rios",
    );
    await user.type(
      screen.getByRole("textbox", { name: /^Correo/ }),
      "admin@example.test",
    );
    const save = screen.getByRole("button", { name: "Guardar" });
    await user.click(save);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: /^Tenant comercial/ }),
      ).toHaveAttribute("aria-invalid", "true"),
    );
    expect(appServices.dataProvider.create).not.toHaveBeenCalled();
    const choice = screen.getByRole("combobox", { name: /^Tenant comercial/ });
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "Destino" }));
    const platform = screen.getByRole("switch", {
      name: "Administrador de plataforma",
    });
    await user.click(platform);
    expect(
      screen.queryByRole("combobox", { name: /^Tenant comercial/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /^Rol en el tenant/ }),
    ).not.toBeInTheDocument();
    await user.click(platform);
    expect(
      await screen.findByRole("combobox", { name: /^Tenant comercial/ }),
    ).toHaveTextContent("Destino");
    await user.click(platform);
    await user.click(save);
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledWith(
        "users",
        expect.objectContaining({
          data: expect.objectContaining({ platformAdmin: true }),
        }),
      ),
    );
  });

  it("lists a tenant without an agency profile", async () => {
    open("/tenants");
    const appServices = services();
    await renderApp(appServices);
    expect(await screen.findByText("Comunidad")).toBeVisible();
    expect(screen.getByRole("link", { name: "Nuevo tenant" })).toBeVisible();
  });

  it("opens the users list scoped to the selected tenant", async () => {
    open("/tenants");
    const user = userEvent.setup();
    await renderApp(services());

    await user.click(await screen.findByText("Comunidad"));

    await waitFor(() => {
      const [, query = ""] = window.location.hash.split("?");
      expect(window.location.hash).toContain("#/users");
      expect(new URLSearchParams(query).get("filter")).toBe('{"tenantId":101}');
    });
    expect(await screen.findByText("Usuarios de Comunidad")).toBeVisible();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(
      screen.getByRole("link", { name: "Configurar acceso" }),
    ).toHaveAttribute("href", "#/service-credentials?tenantId=101&tab=sso");

    await user.click(
      screen.getByRole("button", { name: "Ver todos los usuarios" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByText("Usuarios de Comunidad"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows the internal tenant and opens its platform users", async () => {
    open("/tenants");
    const user = userEvent.setup();
    const appServices = services();
    vi.mocked(appServices.dataProvider.getList).mockImplementation((resource) =>
      Promise.resolve({
        data: resource === "tenants" ? [platformTenant] : [],
        total: resource === "tenants" ? 1 : 0,
      }),
    );
    await renderApp(appServices);

    expect(await screen.findByText("Interno")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /editar/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByText("Plataforma Savia"));

    await waitFor(() => {
      const [, query = ""] = window.location.hash.split("?");
      expect(new URLSearchParams(query).get("filter")).toBe('{"tenantId":0}');
    });
    expect(
      await screen.findByText("Usuarios de Plataforma Savia"),
    ).toBeVisible();
  });

  it("shows a read-only platform tenant with a link to its users", async () => {
    open("/tenants/0");
    const appServices = services();
    const user = userEvent.setup();
    await renderApp(appServices);

    expect(
      await screen.findByRole("heading", { name: "Plataforma Savia" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("switch", { name: "Activo" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Guardar" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Eliminar/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Ver usuarios" }));
    await waitFor(() => {
      const [, query = ""] = window.location.hash.split("?");
      expect(new URLSearchParams(query).get("filter")).toBe('{"tenantId":0}');
    });
    expect(appServices.dataProvider.update).not.toHaveBeenCalled();
    expect(appServices.dataProvider.delete).not.toHaveBeenCalled();
  });

  it("exposes the new-tenant action from the generic tenant list", async () => {
    open("/tenants");
    await renderApp(services());
    const action = await screen.findByRole("link", { name: "Nuevo tenant" });
    expect(action).toHaveAttribute("href", "#/tenants/create");
  });

  it("marks names and email the tenant API would reject before submission", async () => {
    open("/tenants/create");
    const appServices = services();
    const user = userEvent.setup();
    await renderApp(appServices);
    const name = await screen.findByRole("textbox", {
      name: "Nombre del tenant",
    });
    const email = screen.getByRole("textbox", {
      name: "Correo del primer administrador",
    });
    const firstName = screen.getByRole("textbox", {
      name: "Nombres del primer administrador",
    });
    const lastName = screen.getByRole("textbox", {
      name: "Apellidos del primer administrador",
    });
    await user.click(name);
    await user.paste("A".repeat(201));
    await user.type(email, "admin@example");
    await user.type(firstName, "   ");
    await user.click(lastName);
    await user.paste("A".repeat(101));
    const save = screen.getByRole("button", { name: "Guardar" });
    await user.click(save);

    for (const field of [name, email, firstName, lastName])
      expect(field).toHaveAttribute("aria-invalid", "true");
    expect(appServices.dataProvider.create).not.toHaveBeenCalled();

    for (const [field, value] of [
      [name, "Demo"],
      [email, "admin@example.test"],
      [firstName, "Ana María"],
      [lastName, "De la Cruz"],
    ] as const) {
      await user.clear(field);
      await user.type(field, value);
    }
    await user.click(save);
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledTimes(1),
    );
  });

  it("validates the temporary password length before creating a tenant", async () => {
    open("/tenants/create");
    const appServices = services();
    vi.mocked(appServices.dataProvider.create).mockRejectedValueOnce(
      new ApiClientError(
        400,
        "TENANT_TEMPORARY_PASSWORD_INVALID",
        "Invalid password",
      ),
    );
    const user = userEvent.setup();
    await renderApp(appServices);
    await screen.findByText("Nuevo tenant");

    const typeField = (name: string, value: string) =>
      user.type(document.querySelector(`input[name="${name}"]`)!, value);
    await typeField("name", "Demo tenant");
    await typeField("initialUser.email", "demo-admin@example.test");
    await typeField("initialUser.firstName", "Demo");
    await typeField("initialUser.lastName", "Admin");
    await typeField("initialUser.temporaryPassword", "Example123!");
    const save = screen.getByRole("button", { name: "Guardar" });
    await user.click(save);
    await waitFor(() =>
      expect(
        document.querySelector('input[name="initialUser.temporaryPassword"]'),
      ).toHaveAttribute("aria-invalid", "true"),
    );
    expect(appServices.dataProvider.create).not.toHaveBeenCalled();

    await typeField("initialUser.temporaryPassword", "a");
    await user.click(save);
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledTimes(1),
    );
    const password = screen.getByLabelText("Contraseña temporal");
    await waitFor(() => expect(password).toHaveFocus());
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAccessibleDescription(
      /La contraseña temporal debe tener entre 12 y 128 caracteres/,
    );
    expect(password).toHaveValue("Example123!a");

    await user.type(password, "b");
    await user.click(save);
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledTimes(2),
    );
  });

  it("shows a password rejection after switching to an existing administrator", async () => {
    open("/tenants/create");
    const appServices = services();
    let rejectCreate!: (error: Error) => void;
    vi.mocked(appServices.dataProvider.create).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectCreate = reject;
        }),
    );
    const user = userEvent.setup();
    await renderApp(appServices);
    for (const [label, value] of [
      ["Nombre del tenant", "Demo tenant"],
      ["Correo del primer administrador", "demo-admin@example.test"],
      ["Nombres del primer administrador", "Demo"],
      ["Apellidos del primer administrador", "Admin"],
      ["Contraseña temporal", "Example123!a"],
    ]) {
      await user.type(
        await screen.findByLabelText(label, { exact: false }),
        value,
      );
    }
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledTimes(1),
    );
    const transfer = screen.getByRole("radio", {
      name: "Transferir usuario existente",
    });
    await user.click(transfer);
    expect(
      screen.queryByLabelText("Contraseña temporal"),
    ).not.toBeInTheDocument();
    rejectCreate(
      new ApiClientError(
        400,
        "TENANT_TEMPORARY_PASSWORD_INVALID",
        "Invalid password",
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La contraseña temporal debe tener entre 12 y 128 caracteres.",
    );
    expect(transfer).toHaveFocus();
  });

  it("keeps entered data and explains how to recover from unavailable verification email", async () => {
    open("/tenants/create");
    const appServices = services();
    const user = userEvent.setup();
    vi.mocked(appServices.dataProvider.create).mockRejectedValueOnce(
      new ApiClientError(
        503,
        "VERIFICATION_EMAIL_UNAVAILABLE",
        "Verification email delivery is unavailable",
      ),
    );
    await renderApp(appServices);
    const name = await screen.findByRole("textbox", {
      name: "Nombre del tenant",
    });
    await user.type(name, "Tenant de prueba");
    await user.type(
      screen.getByRole("textbox", { name: "Correo del primer administrador" }),
      "tenant-owner@example.test",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Nombres del primer administrador" }),
      "Demo",
    );
    await user.type(
      screen.getByRole("textbox", {
        name: "Apellidos del primer administrador",
      }),
      "Admin",
    );
    await user.type(
      screen.getByLabelText("Contraseña temporal"),
      "Temporary-Test-123!",
    );
    const save = screen.getByRole("button", { name: "Guardar" });
    await user.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "No se pudo enviar el correo de verificación",
    );
    expect(name).toHaveValue("Tenant de prueba");
    expect(screen.getByLabelText("Contraseña temporal")).toHaveValue(
      "Temporary-Test-123!",
    );
    await user.click(screen.getByRole("switch", { name: "Correo verificado" }));
    await user.click(save);
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledTimes(2),
    );
    expect(appServices.dataProvider.create).toHaveBeenLastCalledWith(
      "tenants",
      expect.objectContaining({
        data: expect.objectContaining({
          initialUser: expect.objectContaining({ emailVerified: true }),
        }),
      }),
    );
  });

  it("offers a new-tab tenant list while keeping the draft after an unconfirmed creation", async () => {
    open("/tenants/create");
    const appServices = services();
    vi.mocked(appServices.dataProvider.create).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const user = userEvent.setup();
    await renderApp(appServices);
    for (const [label, value] of [
      ["Nombre del tenant", "Tenant de prueba"],
      ["Correo del primer administrador", "tenant-owner@example.test"],
      ["Nombres del primer administrador", "Demo"],
      ["Apellidos del primer administrador", "Admin"],
      ["Contraseña temporal", "Temporary-Test-123!"],
    ]) {
      await user.type(
        await screen.findByLabelText(label, { exact: false }),
        value,
      );
    }
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "No se pudo confirmar la creación del tenant",
    );
    const link = within(alert).getByRole("link", {
      name: "Ver tenants en otra pestaña",
    });
    expect(link).toHaveAttribute("href", "#/tenants");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByLabelText("Contraseña temporal")).toHaveValue(
      "Temporary-Test-123!",
    );
    expect(window.location.hash).toBe("#/tenants/create");
    expect(appServices.dataProvider.create).toHaveBeenCalledOnce();
  });

  it("shows how to recover from unavailable password setup email", async () => {
    open("/tenants/create");
    const appServices = services();
    const user = userEvent.setup();
    vi.mocked(appServices.dataProvider.create).mockRejectedValueOnce(
      new ApiClientError(
        503,
        "PASSWORD_RESET_EMAIL_UNAVAILABLE",
        "Password reset email delivery is unavailable",
      ),
    );
    await renderApp(appServices);
    const name = await screen.findByRole("textbox", {
      name: "Nombre del tenant",
    });
    await user.type(name, "Tenant de prueba");
    await user.type(
      screen.getByRole("textbox", { name: "Correo del primer administrador" }),
      "owner@example.test",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Nombres del primer administrador" }),
      "Demo",
    );
    await user.type(
      screen.getByRole("textbox", {
        name: "Apellidos del primer administrador",
      }),
      "Admin",
    );
    await user.click(screen.getByRole("switch", { name: "Correo verificado" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo enviar el correo para configurar la contraseña. Usa una contraseña temporal",
    );
    expect(name).toHaveValue("Tenant de prueba");
  });

  it("creates a tenant by transferring an existing user", async () => {
    open("/tenants/create");
    const appServices = services(),
      user = userEvent.setup();
    // jsdom does not implement the scroll operation used by the command list.
    const person = {
      id: "principal-one",
      displayName: "Persona Uno",
      firstName: "Persona",
      lastName: "Uno",
      email: "person@example.test",
      platformAdmin: false,
      isActive: true,
      isBanned: false,
      twoFactorEnabled: false,
      memberships: [
        {
          id: "membership-one",
          tenantId: 101,
          agencyId: 101,
          role: "tenant_admin",
          isActive: true,
        },
      ],
    };
    vi.mocked(appServices.dataProvider.getList).mockImplementation((resource) =>
      Promise.resolve({
        data:
          resource === "users"
            ? [
                person,
                { ...person, id: "principal-two", email: "other@example.test" },
              ]
            : [],
        total: resource === "users" ? 2 : 0,
      }),
    );
    const createdTenant = {
      ...tenant,
      name: "Nueva comunidad",
      idSlug: "nueva-comunidad-2",
    };
    vi.mocked(appServices.dataProvider.create).mockResolvedValue({
      data: createdTenant,
    });
    vi.mocked(appServices.dataProvider.create).mockRejectedValueOnce(
      new ApiClientError(409, "TENANT_CONFLICT", "Transfer rejected", {
        error: { code: "TENANT_CONFLICT", reason: "LAST_ACTIVE_MEMBER" },
      }),
    );
    vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
      data: createdTenant,
    });
    await renderApp(appServices);
    expect(await screen.findByText("Nuevo tenant")).toBeVisible();
    // The shared text inputs do not associate their labels programmatically,
    // so target them by field name like the record data does.
    const nameInput = document.querySelector(
      'input[name="name"]',
    ) as HTMLInputElement;
    expect(nameInput).not.toBe(null);
    expect(document.querySelector('input[name="idSlug"]')).toBe(null);
    expect(
      screen.getByText(
        "La URL del tenant se asigna automáticamente a partir de su nombre y no cambia al renombrarlo.",
      ),
    ).toBeVisible();
    await user.type(nameInput, "Nueva comunidad");
    await user.click(
      await screen.findByRole("radio", {
        name: "Transferir usuario existente",
      }),
    );
    expect(
      await screen.findByText(
        "El usuario dejará su organización actual: la transferencia no comparte la cuenta.",
      ),
    ).toBeVisible();
    expect(document.querySelector('input[name="initialUser.email"]')).toBe(
      null,
    );
    await user.click(
      await screen.findByRole("combobox", { name: "Usuario existente" }),
    );
    expect(
      await screen.findByRole("option", {
        name: "Persona Uno other@example.test",
      }),
    ).toBeVisible();
    await user.type(
      screen.getByRole("combobox", { name: "" }),
      "person@example.test",
    );
    await waitFor(() =>
      expect(appServices.dataProvider.getList).toHaveBeenCalledWith(
        "users",
        expect.objectContaining({ filter: { q: "person@example.test" } }),
      ),
    );
    await user.click(
      await screen.findByRole("option", {
        name: "Persona Uno person@example.test",
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Usuario existente" }),
    ).toHaveTextContent("Persona Uno person@example.test");
    expect(
      screen.getByRole("combobox", { name: "Usuario existente" }),
    ).toHaveAccessibleDescription(
      "El usuario dejará su organización actual: la transferencia no comparte la cuenta. Persona Uno person@example.test",
    );
    await user.click(screen.getByRole("button", { name: /Guardar/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "El usuario es el último miembro activo de su organización",
    );
    expect(nameInput).toHaveValue("Nueva comunidad");
    await user.click(screen.getByRole("button", { name: /Guardar/ }));
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledWith(
        "tenants",
        expect.objectContaining({
          data: expect.objectContaining({
            name: "Nueva comunidad",
            memberMode: "existing",
            existingUserId: "principal-one",
            existingRole: "tenant_admin",
          }),
        }),
      ),
    );
    await user.click(await screen.findByRole("tab", { name: "Acceso" }));
    const url = "https://nueva-comunidad-2.savia-preview.hefesoft.com";
    expect(
      await screen.findByRole("textbox", { name: "Tu URL de Savia" }),
    ).toHaveValue(url);
    expect(window.location.hash).toBe("#/tenants/101");
    await user.click(screen.getByRole("button", { name: "Copiar enlace" }));
    expect(await navigator.clipboard.readText()).toBe(url);
    expect(await screen.findByText("Enlace copiado.")).toBeVisible();
  });

  it("edits the tenant state and explains the effect on member access", async () => {
    open("/tenants/101");
    const appServices = services(),
      user = userEvent.setup();
    Object.assign(appServices, {
      apiClient: {
        get: vi.fn((path: string) => {
          if (path === "/v1/tenant-workspaces")
            return Promise.resolve({ data: [] });
          if (path.endsWith("/api-keys/members"))
            return Promise.resolve({
              members: [
                {
                  id: "member-1",
                  displayName: "Alex",
                  email: "alex@example.test",
                },
              ],
            });
          if (path.endsWith("/api-keys")) return Promise.resolve({ keys: [] });
          return Promise.reject(new Error(`Unexpected API request: ${path}`));
        }),
        post: vi.fn(),
        delete: vi.fn(),
      },
    });
    await renderApp(appServices);
    const name = await screen.findByDisplayValue("Comunidad");
    await user.clear(name);
    await user.type(name, "Comunidad renovada");
    await user.click(await screen.findByRole("tab", { name: "Claves API" }));
    await user.click(
      await screen.findByRole("button", { name: "Nueva clave" }),
    );
    const keyName = await screen.findByLabelText("Nombre de la clave");
    expect(keyName.closest("form")).toBeNull();
    await user.type(keyName, "Companion{Enter}");
    expect(appServices.dataProvider.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Acceso" }));
    expect(
      screen.getByRole("link", { name: "Configurar SSO" }),
    ).toHaveAttribute("href", "#/service-credentials?tenantId=101&tab=sso");
    expect(
      screen.getByRole("link", { name: "Configurar Google / Microsoft" }),
    ).toHaveAttribute("href", "#/service-credentials?tenantId=101&tab=social");
    await user.click(screen.getByRole("tab", { name: "General" }));
    expect(document.querySelector('input[name="idSlug"]')).toBe(null);
    expect(
      screen.getByText(
        "La URL del tenant se asigna automáticamente a partir de su nombre y no cambia al renombrarlo.",
      ),
    ).toBeVisible();
    expect(name).toHaveValue("Comunidad renovada");
    expect(
      screen.getByText(
        "Desactivar el tenant suspende el acceso de sus miembros.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Guardar/ }));
    await waitFor(() =>
      expect(appServices.dataProvider.update).toHaveBeenCalledWith(
        "tenants",
        expect.objectContaining({
          id: "101",
          data: { name: "Comunidad renovada" },
        }),
      ),
    );
  });

  it("saves the changed tenant activity without resending its name or URL", async () => {
    open("/tenants/101");
    const appServices = services();
    const user = userEvent.setup();
    await renderApp(appServices);
    const active = await screen.findByRole("switch", { name: "Activo" });
    expect(active).toBeChecked();
    await user.click(active);
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(appServices.dataProvider.update).toHaveBeenCalledWith(
        "tenants",
        expect.objectContaining({
          id: "101",
          data: { isActive: false },
        }),
      ),
    );
  });

  it("does not submit tenant settings when only the surrounding whitespace changes", async () => {
    open("/tenants/101");
    const appServices = services();
    const user = userEvent.setup();
    await renderApp(appServices);
    const name = await screen.findByDisplayValue("Comunidad");
    const save = screen.getByRole("button", { name: "Guardar" });
    expect(save).toBeDisabled();

    await user.type(name, " nueva");
    expect(save).toBeEnabled();
    await user.clear(name);
    await user.type(name, " Comunidad ");
    expect(save).toBeDisabled();

    await act(async () => {
      fireEvent.submit(name.closest("form")!);
    });
    expect(appServices.dataProvider.update).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/tenants/101");
  });

  it("waits for tenant settings to save and preserves the draft after a timeout", async () => {
    open("/tenants/101");
    const appServices = services();
    let rejectSave!: (error: Error) => void;
    vi.mocked(appServices.dataProvider.update).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    const user = userEvent.setup();
    await renderApp(appServices);
    const name = await screen.findByDisplayValue("Comunidad");
    await user.clear(name);
    await user.type(name, "Comunidad renovada");
    const save = screen.getByRole("button", { name: "Guardar" });
    await user.click(save);
    await waitFor(() =>
      expect(appServices.dataProvider.update).toHaveBeenCalledTimes(1),
    );
    expect(window.location.hash).toBe("#/tenants/101");
    expect(save).toBeDisabled();

    rejectSave(new ApiClientError(0, "REQUEST_TIMEOUT", "Request timed out."));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo confirmar el guardado. Abre el tenant en otra pestaña para comprobar los cambios antes de reintentar.",
    );
    expect(window.location.hash).toBe("#/tenants/101");
    expect(name).toHaveValue("Comunidad renovada");

    await user.click(save);
    await waitFor(() =>
      expect(appServices.dataProvider.update).toHaveBeenCalledTimes(2),
    );
  });

  it("requires the exact tenant name before a platform admin can cascade delete it", async () => {
    open("/tenants/101");
    const appServices = services(),
      user = userEvent.setup();
    let finishDelete!: (result: { data: typeof tenant }) => void;
    vi.mocked(appServices.dataProvider.delete).mockReturnValue(
      new Promise((resolve) => {
        finishDelete = resolve;
      }),
    );
    await renderApp(appServices);

    const deleteAction = await screen.findByRole("button", {
      name: "Eliminar tenant y todos sus datos",
    });
    expect(screen.getAllByRole("button", { name: /^Eliminar/ })).toEqual([
      deleteAction,
    ]);
    await user.click(deleteAction);
    const confirmation = await screen.findByRole("textbox", {
      name: "Escribe Comunidad para confirmar",
    });
    const confirmButton = screen.getByRole("button", {
      name: "Eliminar definitivamente",
    });

    await user.type(confirmation, "comunidad");
    await user.click(confirmButton);
    expect(appServices.dataProvider.delete).not.toHaveBeenCalled();

    await user.clear(confirmation);
    await user.type(confirmation, "Comunidad");
    await user.click(confirmButton);
    await waitFor(() =>
      expect(appServices.dataProvider.delete).toHaveBeenCalledWith(
        "tenants",
        expect.objectContaining({
          id: 101,
          meta: { cascade: true, confirmation: "Comunidad" },
        }),
      ),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eliminando…" })).toBeDisabled();
    finishDelete({ data: tenant });
    await waitFor(() => expect(window.location.hash).toBe("#/tenants"));
  });

  it.each([
    {
      error: new ApiClientError(
        409,
        "TENANT_PURGE_IN_PROGRESS",
        "Another tenant operation is in progress.",
      ),
      message:
        "Hay una operación en curso para este tenant. Espera a que termine antes de reintentar.",
    },
    {
      error: new ApiClientError(409, "HTTP_409", "Conflict"),
      message:
        "Un conflicto interrumpió la eliminación. Actualiza el tenant y vuelve a intentarlo.",
    },
    {
      error: new ApiClientError(
        409,
        "TENANT_BRANDING_UPLOAD_IN_PROGRESS",
        "Upload in progress.",
      ),
      message:
        "Hay una imagen del tenant que se está subiendo. Espera a que termine y vuelve a intentar la eliminación.",
    },
    {
      error: new ApiClientError(
        503,
        "TENANT_CLEANUP_UNAVAILABLE",
        "Cleanup unavailable.",
      ),
      message:
        "Algunos servicios de limpieza no están disponibles. Actualiza el tenant e intenta eliminarlo de nuevo.",
    },
    {
      error: new ApiClientError(
        503,
        "TENANT_REQUEST_CLEANUP_UNAVAILABLE",
        "Savia Request cleanup unavailable.",
      ),
      message:
        "No se pudo completar la limpieza de Savia Request. El tenant quedó inactivo. Intenta eliminarlo de nuevo.",
    },
    {
      error: new ApiClientError(0, "REQUEST_TIMEOUT", "Request timed out."),
      message:
        "No se recibió el resultado de la eliminación. Actualiza la lista de tenants para comprobar su estado antes de reintentar.",
    },
    {
      error: new TypeError("Failed to fetch"),
      message:
        "No se recibió el resultado de la eliminación. Actualiza la lista de tenants para comprobar su estado antes de reintentar.",
    },
    {
      error: new ApiClientError(502, "HTTP_502", "Bad Gateway"),
      message:
        "No se recibió el resultado de la eliminación. Actualiza la lista de tenants para comprobar su estado antes de reintentar.",
    },
    {
      error: new ApiClientError(
        503,
        "TENANT_AUTH_CLEANUP_UNAVAILABLE",
        "Auth unavailable.",
      ),
      message:
        "No se pudo eliminar la configuración de autenticación. El tenant quedó inactivo. Intenta eliminarlo de nuevo.",
    },
    {
      error: new ApiClientError(
        503,
        "TENANT_FILE_CLEANUP_UNAVAILABLE",
        "Storage unavailable.",
      ),
      message:
        "No se pudo completar la limpieza de archivos. El tenant quedó inactivo. Intenta eliminarlo de nuevo.",
    },
  ])(
    "explains $error.code and refreshes the tenant",
    async ({ error, message }) => {
      open("/tenants/101");
      const appServices = services(),
        user = userEvent.setup();
      vi.mocked(appServices.dataProvider.delete).mockRejectedValue(error);
      await renderApp(appServices);
      await screen.findByDisplayValue("Comunidad");
      vi.mocked(appServices.dataProvider.getOne).mockClear();

      await user.click(
        await screen.findByRole("button", {
          name: "Eliminar tenant y todos sus datos",
        }),
      );
      await user.type(
        await screen.findByRole("textbox", {
          name: "Escribe Comunidad para confirmar",
        }),
        "Comunidad",
      );
      await user.click(
        screen.getByRole("button", { name: "Eliminar definitivamente" }),
      );

      const dialog = screen.getByRole("dialog");
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        message,
      );
      expect(
        screen.getByRole("textbox", {
          name: "Escribe Comunidad para confirmar",
        }),
      ).toHaveValue("Comunidad");
      await waitFor(() =>
        expect(appServices.dataProvider.getOne).toHaveBeenCalledWith(
          "tenants",
          expect.objectContaining({ id: "101" }),
        ),
      );
    },
  );

  it("explains when the tenant name confirmation is stale", async () => {
    open("/tenants/101");
    const appServices = services(),
      user = userEvent.setup();
    vi.mocked(appServices.dataProvider.delete).mockRejectedValue(
      new ApiClientError(
        400,
        "TENANT_CONFIRMATION_REQUIRED",
        "Escribe el nombre exacto del tenant para eliminarlo con todos sus datos.",
      ),
    );
    await renderApp(appServices);
    let finishRefresh!: (result: { data: typeof tenant }) => void;
    vi.mocked(appServices.dataProvider.getOne).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Eliminar tenant y todos sus datos",
      }),
    );
    await user.type(
      await screen.findByRole("textbox", {
        name: "Escribe Comunidad para confirmar",
      }),
      "Comunidad",
    );
    await user.click(
      screen.getByRole("button", { name: "Eliminar definitivamente" }),
    );

    expect(
      await screen.findByText(
        "El nombre del tenant cambió o no coincide. Actualiza el tenant y confirma con su nombre actual.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", {
      name: "Eliminar definitivamente",
    });
    expect(confirmButton).toBeDisabled();
    await waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
    const staleConfirmation = screen.getByRole("textbox", {
      name: "Escribe Comunidad para confirmar",
    });
    expect(staleConfirmation).toHaveValue("");
    expect(staleConfirmation).toBeDisabled();
    finishRefresh({ data: { ...tenant, name: "Comunidad renovada" } });
    const confirmation = await screen.findByRole("textbox", {
      name: "Escribe Comunidad renovada para confirmar",
    });
    await user.type(confirmation, "Comunidad");
    expect(confirmButton).toBeDisabled();
    await user.type(confirmation, " renovada");
    expect(confirmButton).toBeEnabled();
    expect(appServices.dataProvider.delete).toHaveBeenCalledTimes(1);
  });

  it("hides cascade deletion from users without platform administration", async () => {
    open("/tenants/101");
    const appServices = services();
    vi.mocked(appServices.authProvider.getPermissions!).mockResolvedValue({
      memberships: [{ tenantId: 101, role: "tenant_admin" }],
      canManageIdentity: false,
    });
    await renderApp(appServices);

    await screen.findByDisplayValue("Comunidad");
    expect(
      screen.queryByRole("button", {
        name: "Eliminar tenant y todos sus datos",
      }),
    ).not.toBeInTheDocument();
  });
});
