import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import type { AppServices } from "@/app-services";
import { ApiClientError } from "@/api/api-client";
import { useRealtimeTopics } from "@/realtime/use-realtime";

vi.mock("@/realtime/use-realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/use-realtime")>()),
  useRealtimeTopics: vi.fn(() => ({ status: "connecting", lastEvent: null })),
}));

const tenantAdminPermissions = {
  canReadDocuments: true,
  canExecuteCommands: false,
  canManageIdentity: false,
  memberships: [{ tenantId: 101, role: "tenant_admin" }],
};

function services() {
  const dataProvider = {
    getList: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    getOne: vi
      .fn()
      .mockResolvedValue({ data: { id: 101, name: "North workspace" } }),
    getMany: vi.fn().mockResolvedValue({ data: [] }),
    getManyReference: vi.fn(),
    create: vi.fn().mockResolvedValue({ data: { id: "new-user" } }),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  return {
    authSession: {
      checkSession: vi.fn(),
      getPermissions: vi.fn().mockResolvedValue(tenantAdminPermissions),
      getIdentity: vi.fn(),
    },
    authProvider: {
      checkAuth: vi.fn().mockResolvedValue(undefined),
      checkError: vi.fn(),
      getIdentity: vi
        .fn()
        .mockResolvedValue({ id: "admin", fullName: "Admin" }),
      getPermissions: vi.fn().mockResolvedValue(tenantAdminPermissions),
      canAccess: vi.fn().mockResolvedValue(true),
      login: vi.fn(),
      logout: vi.fn(),
    },
    dataProvider,
    apiClient: {
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes("user-capacity")) {
          return {
            data: { tenantId: 101, maxActiveUsers: null, activeUsers: 1 },
          };
        }
        if (path.includes("access-control/roles")) return { roles: [] };
        throw new Error(`Unexpected API request: ${path}`);
      }),
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
  await act(async () => {
    render(<App services={appServices} />);
  });
}

function open(path: string) {
  window.history.replaceState({}, "", "/");
  window.location.hash = `#${path}`;
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path !== "/api/public/tenant-branding")
      throw new Error(`Unexpected user-page request: ${path}`);
    return new Response(JSON.stringify({ data: null }), {
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("tenant-admin user pages", () => {
  it("preserves a user draft when a tenant membership event arrives", async () => {
    open("/users/user-1");
    const appServices = services();
    const record = {
      id: "user-1",
      displayName: "Ari Rios",
      firstName: "Ari",
      lastName: "Rios",
      email: "ari@example.test",
      platformAdmin: false,
      isActive: true,
      memberships: [{ tenantId: 101, role: "viewer", isActive: true }],
    };
    vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
      data: record,
    });
    await renderApp(appServices);
    const firstName = await screen.findByDisplayValue("Ari");
    fireEvent.change(firstName, { target: { value: "Draft" } });
    const subscription = vi
      .mocked(useRealtimeTopics)
      .mock.calls.map(([options]) => options)
      .filter(
        (options) =>
          options.enabled && options.topics.includes("access-control"),
      )
      .at(-1);
    expect(subscription).toMatchObject({ tenantId: 101 });
    vi.useFakeTimers();
    try {
      await act(async () => {
        subscription?.onEvent?.({
          topic: "access-control",
          type: "updated",
          collection: "memberships",
          id: "another-user",
        });
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(
        screen.queryByRole("button", { name: /descartar/i }),
      ).not.toBeInTheDocument();
      expect(firstName).toHaveValue("Draft");
    } finally {
      vi.useRealTimers();
    }
    vi.mocked(appServices.dataProvider.getOne)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({
        data: { ...record, firstName: "Updated", displayName: "Updated Rios" },
      });
    await act(async () => {
      subscription?.onEvent?.({
        topic: "access-control",
        type: "updated",
        collection: "memberships",
        id: record.id,
      });
    });
    expect(
      await screen.findByRole("button", { name: /descartar/i }),
    ).toBeVisible();
    expect(firstName).toHaveValue("Draft");
    let rejectSave!: (error: Error) => void;
    vi.mocked(appServices.dataProvider.update).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(rejectSave).toBeTypeOf("function"));
    expect(screen.getByRole("button", { name: /descartar/i })).toBeDisabled();
    await act(async () => {
      rejectSave(new Error("Save rejected"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /descartar/i }));
    });
    expect(window.location.hash).toBe("#/users/user-1");
    expect(firstName).toHaveValue("Draft");
    expect(screen.getByRole("button", { name: /descartar/i })).toBeVisible();
    const updated = {
      ...record,
      firstName: "Updated",
      displayName: "Updated Rios",
    };
    let finishReload!: (result: { data: typeof record }) => void;
    vi.mocked(appServices.dataProvider.getOne).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: /descartar/i }));
    await waitFor(() => expect(finishReload).toBeTypeOf("function"));
    const reload = screen.getByRole("button", { name: "Recargando…" });
    expect(reload).toBeDisabled();
    const reads = vi.mocked(appServices.dataProvider.getOne).mock.calls.length;
    fireEvent.click(reload);
    fireEvent.change(firstName, {
      target: { value: "Edited while reloading" },
    });
    await act(async () => {
      finishReload({ data: updated });
    });
    expect(firstName).toHaveValue("Edited while reloading");
    expect(appServices.dataProvider.getOne).toHaveBeenCalledTimes(reads);

    await act(async () => {
      subscription?.onEvent?.({
        topic: "access-control",
        type: "updated",
        collection: "memberships",
        id: record.id,
      });
    });
    await screen.findByRole("button", { name: /descartar/i });
    fireEvent.click(screen.getByRole("button", { name: /descartar/i }));
    expect(await screen.findByDisplayValue("Updated")).toBeVisible();
  });

  it("creates users in the administrator's tenant without platform or tenant-transfer controls", async () => {
    open("/users/create");
    const appServices = services();
    vi.mocked(appServices.dataProvider.create).mockRejectedValueOnce(
      new ApiClientError(
        400,
        "USER_TEMPORARY_PASSWORD_INVALID",
        "Invalid password",
      ),
    );
    await renderApp(appServices);

    expect(await screen.findByLabelText("Tenant")).toHaveValue(101);
    expect(screen.getByLabelText("Tenant")).toHaveAttribute("readonly");
    expect(screen.queryByLabelText("Administrador de plataforma")).toBeNull();
    expect(screen.queryByLabelText("Tenant comercial")).toBeNull();
    const identityFields = screen.getAllByRole("textbox");
    fireEvent.change(identityFields[0], {
      target: { value: "Ari" },
    });
    fireEvent.change(identityFields[1], {
      target: { value: "   " },
    });
    fireEvent.change(identityFields[2], {
      target: { value: "ari@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(identityFields[1]).toHaveAttribute("aria-invalid", "true"),
    );
    expect(appServices.dataProvider.create).not.toHaveBeenCalled();

    fireEvent.change(identityFields[1], { target: { value: "Rios" } });
    await waitFor(() =>
      expect(identityFields[1]).toHaveAttribute("aria-invalid", "false"),
    );
    const password = screen.getByLabelText("Contraseña temporal");
    const save = screen.getByRole("button", { name: "Guardar" });
    fireEvent.change(password, { target: { value: "too-short" } });
    fireEvent.click(save);
    expect(
      await screen.findByText("Debe tener al menos 12 caracteres"),
    ).toBeVisible();
    expect(appServices.dataProvider.create).not.toHaveBeenCalled();
    fireEvent.change(password, { target: { value: "a".repeat(129) } });
    expect(
      await screen.findByText("Debe tener 128 caracteres o menos"),
    ).toBeVisible();
    expect(appServices.dataProvider.create).not.toHaveBeenCalled();

    const temporaryPassword = "example-12!?";
    fireEvent.change(password, { target: { value: temporaryPassword } });
    await waitFor(() =>
      expect(password).toHaveAttribute("aria-invalid", "false"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledWith(
        "users",
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: 101,
            platformAdmin: false,
            agencyRole: "viewer",
            temporaryPassword,
          }),
        }),
      ),
    );
    await waitFor(() => expect(password).toHaveFocus());
    expect(password).toHaveAccessibleDescription(
      /La contraseña temporal debe tener entre 12 y 128 caracteres/,
    );
    expect(password).toHaveValue(temporaryPassword);
    expect(identityFields[0]).toHaveValue("Ari");

    fireEvent.change(password, { target: { value: `${temporaryPassword}a` } });
    await waitFor(() =>
      expect(password).toHaveAttribute("aria-invalid", "false"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(appServices.dataProvider.create).toHaveBeenCalledTimes(2),
    );
  });

  it.each(["North workspace", ""])(
    "uses the tenant name without exposing IDs when the name is %s",
    async (name) => {
      open("/users");
      const appServices = services();
      vi.mocked(appServices.dataProvider.getOne).mockResolvedValue({
        data: { id: 101, name },
      });
      vi.mocked(appServices.dataProvider.getList).mockImplementation(
        async (resource) =>
          resource === "users"
            ? {
                data: [
                  {
                    id: "user-1",
                    displayName: "Ari Rios",
                    email: "ari@example.test",
                    platformAdmin: false,
                    isActive: true,
                    twoFactorEnabled: false,
                    memberships: [
                      {
                        tenantId: 101,
                        agencyId: 101,
                        role: "viewer",
                        isActive: true,
                      },
                    ],
                  },
                ],
                total: 1,
              }
            : { data: [], total: 0 },
      );
      await renderApp(appServices);
      expect(await screen.findByText("ari@example.test")).toBeVisible();
      if (name) {
        expect(
          await screen.findByText("Usuarios de North workspace"),
        ).toBeVisible();
        expect(
          await screen.findByText("North workspace", { selector: "td span" }),
        ).toBeVisible();
      } else {
        expect(await screen.findByText("Usuarios del tenant")).toBeVisible();
      }
      expect(screen.queryByText(/#101/)).not.toBeInTheDocument();
    },
  );

  it("does not expose tenant selection from the tenant-admin user list", async () => {
    open("/users");
    const appServices = services();
    await renderApp(appServices);

    expect(
      await screen.findByText("Usuarios de North workspace"),
    ).toBeVisible();
    expect(screen.queryByLabelText("Tenant comercial")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Ver todos los usuarios" }),
    ).toBeNull();
    await waitFor(() =>
      expect(appServices.dataProvider.getList).toHaveBeenCalled(),
    );
  });

  it("refreshes the tenant-admin users list after a scoped membership update", async () => {
    open("/users");
    const appServices = services();
    vi.mocked(appServices.dataProvider.getList).mockImplementation(
      async (resource) =>
        resource === "users"
          ? {
              data: [
                {
                  id: "user-1",
                  displayName: "Ari Rios",
                  email: "ari@example.test",
                  isActive: true,
                  platformAdmin: false,
                  memberships: [
                    { tenantId: 101, role: "viewer", isActive: true },
                  ],
                },
              ],
              total: 1,
            }
          : { data: [], total: 0 },
    );
    await renderApp(appServices);
    expect(await screen.findByText("ari@example.test")).toBeVisible();
    const subscription = vi
      .mocked(useRealtimeTopics)
      .mock.calls.map(([options]) => options)
      .filter(
        (options) =>
          options.enabled && options.topics.includes("access-control"),
      )
      .at(-1);
    expect(subscription).toMatchObject({
      tenantId: 101,
      topics: ["access-control"],
    });
    const listCalls = vi.mocked(appServices.dataProvider.getList).mock.calls
      .length;
    await act(async () => {
      subscription?.onEvent?.({
        topic: "access-control",
        type: "updated",
        collection: "roles",
      });
    });
    expect(appServices.dataProvider.getList).toHaveBeenCalledTimes(listCalls);
    vi.mocked(appServices.dataProvider.getList).mockResolvedValue({
      data: [],
      total: 0,
    });
    await act(async () => {
      subscription?.onEvent?.({
        topic: "access-control",
        type: "updated",
        collection: "memberships",
      });
    });
    await waitFor(() =>
      expect(screen.queryByText("ari@example.test")).not.toBeInTheDocument(),
    );
  });
});
