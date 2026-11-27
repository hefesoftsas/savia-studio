import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useStudioSidebarNavigation } from "./use-studio-sidebar-navigation";
import { beginLogout } from "@/auth/logout-progress";
import { getSessionGeneration, rotateSessionScope } from "@/auth/session-scope";
import { ApiClientError } from "@/api/api-client";
import { STUDIO_TENANTS_CHANGED } from "./studio-tenants";

type RealtimeOptions = {
  topics: string[];
  tenantId?: number;
  enabled?: boolean;
  onConnected?: () => void;
  onEvent?: (event: {
    topic: string;
    type: "created" | "updated" | "deleted";
    collection?: string;
  }) => void;
};

const { transport, studioTenants, mockedServices } = vi.hoisted(() => ({
  transport: vi.fn((_options: RealtimeOptions) => ({
    status: "live" as const,
  })),
  studioTenants: vi.fn(),
  mockedServices: {
    apiClient: {
      get: vi.fn(async () => ({
        data: [{ name: "claims", label: "After" }],
      })),
    },
    localData: {
      cachedMetadata: vi.fn(async () => ({
        data: [{ name: "claims", label: "Before" }],
      })),
    },
  },
}));

vi.mock("@/realtime/use-realtime", () => ({
  useRealtimeTopics: transport,
}));
vi.mock("@/features/assistant/assistant-context", () => ({
  useAppServices: () => mockedServices,
}));
vi.mock("@/i18n/core", () => ({ useAppLocale: () => "es" }));
vi.mock("./studio-tenants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./studio-tenants")>()),
  listStudioTenants: studioTenants,
}));

const tenant = {
  id: "tenant:42",
  tenantId: 42,
  label: "North",
  kind: "tenant",
  apiBasePath: "/v1/studio/42",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  studioTenants.mockReset();
  mockedServices.apiClient.get.mockReset();
  mockedServices.localData.cachedMetadata.mockReset();
});

it("refreshes cached Studio sidebar metadata on the first tenant socket acknowledgement", async () => {
  studioTenants.mockResolvedValue([tenant]);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={["/studio?tenantId=42"]}>
      {children}
    </MemoryRouter>
  );
  const { result } = renderHook(() => useStudioSidebarNavigation(true), {
    wrapper,
  });

  await waitFor(() => {
    expect(
      result.current.children.find((child) => child.id === "object:claims")
        ?.label,
    ).toBe("Before");
  });
  expect(mockedServices.localData.cachedMetadata).toHaveBeenCalledOnce();

  const studioConnection = transport.mock.calls
    .map(([options]) => options)
    .reverse()
    .find(
      (options) =>
        options.enabled &&
        options.tenantId === 42 &&
        options.topics.includes("studio"),
    );
  expect(studioConnection).toBeDefined();

  act(() => studioConnection?.onConnected?.());

  await waitFor(() => {
    expect(
      result.current.children.find((child) => child.id === "object:claims")
        ?.label,
    ).toBe("After");
  });
  expect(mockedServices.apiClient.get).toHaveBeenCalledWith(
    "/v1/studio/42/api/objects",
    { signal: expect.any(AbortSignal) },
  );
});

it("keeps the selected HubSpot total across catalog refreshes", async () => {
  studioTenants.mockResolvedValue([tenant]);
  const contacts = {
    name: "hubspot_contacts",
    label: "Contactos",
    count: 0,
    config: { studio: { collection: { kind: "crm", sourceId: "hubspot" } } },
  };
  mockedServices.localData.cachedMetadata.mockResolvedValueOnce({
    data: [contacts],
  });
  mockedServices.apiClient.get.mockResolvedValueOnce({
    data: [{ ...contacts, label: "Contactos CRM" }],
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter
      initialEntries={["/studio?tenantId=42&object=hubspot_contacts"]}
    >
      {children}
    </MemoryRouter>
  );
  const { result } = renderHook(() => useStudioSidebarNavigation(true), {
    wrapper,
  });
  const contactItem = () =>
    result.current.children.find(
      (child) => child.id === "object:hubspot_contacts",
    );
  await waitFor(() => expect(contactItem()?.label).toBe("Contactos"));
  expect(contactItem()?.count).toBeUndefined();

  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: "savia-studio-navigation",
          tenantId: 42,
          sessionGeneration: getSessionGeneration(),
          objects: [contacts],
          hubspotCount: { name: contacts.name, total: 6 },
        },
      }),
    );
  });
  expect(contactItem()?.count).toBe(6);

  const studioConnection = transport.mock.calls
    .map(([options]) => options)
    .find((options) => options.enabled && options.tenantId === 42);
  act(() => studioConnection?.onConnected?.());
  await waitFor(() =>
    expect(contactItem()).toMatchObject({ label: "Contactos CRM", count: 6 }),
  );
});

it("clears old sidebar metadata and ignores delayed messages when the same tenant is authorized for a new account", async () => {
  const previousGeneration = getSessionGeneration();
  const contacts = {
    name: "hubspot_contacts",
    label: "Old contacts",
    config: { studio: { collection: { kind: "crm", sourceId: "hubspot" } } },
  };
  const newContacts = { ...contacts, label: "Current contacts" };
  let authorize!: (result: (typeof tenant)[]) => void;
  const pending = new Promise<(typeof tenant)[]>((resolve) => {
    authorize = resolve;
  });
  studioTenants.mockResolvedValueOnce([tenant]).mockReturnValueOnce(pending);
  mockedServices.localData.cachedMetadata
    .mockResolvedValueOnce({ data: [contacts] })
    .mockResolvedValueOnce({ data: [newContacts] });
  const { result } = renderHook(() => useStudioSidebarNavigation(true), {
    wrapper: ({ children }) => (
      <MemoryRouter
        initialEntries={["/studio?tenantId=42&object=hubspot_contacts"]}
      >
        {children}
      </MemoryRouter>
    ),
  });
  const contactsItem = () =>
    result.current.children.find(
      (child) => child.id === "object:hubspot_contacts",
    );
  const announce = (
    sessionGeneration: number,
    object: typeof contacts,
    total: number,
  ) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: "savia-studio-navigation",
          tenantId: 42,
          sessionGeneration,
          objects: [object],
          hubspotCount: { name: object.name, total },
        },
      }),
    );
  };
  await waitFor(() => expect(contactsItem()?.label).toBe(contacts.label));
  act(() => announce(previousGeneration, contacts, 6));
  expect(contactsItem()?.count).toBe(6);

  act(() => rotateSessionScope("principal-change"));
  expect(result.current.tenantId).toBeUndefined();
  expect(contactsItem()).toBeUndefined();
  expect(
    result.current.children.find((child) => child.id === "studio:admin")?.route,
  ).not.toContain("object=");

  await act(async () => authorize([tenant]));
  await waitFor(() => expect(contactsItem()?.label).toBe(newContacts.label));
  expect(contactsItem()?.count).toBeUndefined();
  act(() => announce(previousGeneration, contacts, 99));
  expect(contactsItem()?.label).toBe(newContacts.label);
  expect(contactsItem()?.count).toBeUndefined();
  act(() => announce(getSessionGeneration(), newContacts, 10));
  expect(contactsItem()?.count).toBe(10);
});

it("discards a queued Studio sidebar refresh when logout starts", async () => {
  studioTenants.mockResolvedValue([tenant]);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={["/studio?tenantId=42"]}>
      {children}
    </MemoryRouter>
  );
  const { result } = renderHook(() => useStudioSidebarNavigation(true), {
    wrapper,
  });
  await waitFor(() =>
    expect(
      result.current.children.some((child) => child.group === "objects"),
    ).toBe(true),
  );
  const studioConnection = transport.mock.calls
    .map(([options]) => options)
    .find((options) => options.enabled && options.tenantId === 42);
  expect(studioConnection).toBeDefined();
  vi.useFakeTimers();
  let finishLogout!: () => void;
  try {
    act(() => studioConnection?.onConnected?.());
    act(() => {
      finishLogout = beginLogout();
    });
    expect(result.current.tenantId).toBeUndefined();
    expect(
      result.current.children.some((child) => child.group === "objects"),
    ).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(mockedServices.apiClient.get).not.toHaveBeenCalled();
  } finally {
    cleanup();
    finishLogout?.();
    vi.useRealTimers();
  }
});

it.each([503, 403])(
  "handles a %s while refreshing the sidebar workspace catalog",
  async (status) => {
    studioTenants
      .mockResolvedValueOnce([tenant])
      .mockRejectedValueOnce(
        new ApiClientError(
          status,
          "read_failed",
          "Unable to read the workspace catalog",
        ),
      );
    const { result } = renderHook(() => useStudioSidebarNavigation(true), {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={["/studio?tenantId=42"]}>
          {children}
        </MemoryRouter>
      ),
    });
    const hasObjects = () =>
      result.current.children.some((child) => child.group === "objects");
    await waitFor(() => expect(hasObjects()).toBe(true));

    await act(async () =>
      window.dispatchEvent(new Event(STUDIO_TENANTS_CHANGED)),
    );
    expect(studioTenants).toHaveBeenCalledTimes(2);
    expect(result.current.tenantId).toBe(status === 503 ? 42 : undefined);
    expect(hasObjects()).toBe(status === 503);
  },
);

it("ignores an older pending metadata response when Studio reports a denial", async () => {
  studioTenants.mockResolvedValue([tenant]);
  let finishRead!: (response: {
    data: { name: string; label: string }[];
  }) => void;
  const pending = new Promise<{ data: { name: string; label: string }[] }>(
    (resolve) => {
      finishRead = resolve;
    },
  );
  mockedServices.apiClient.get.mockReturnValueOnce(pending);
  const { result } = renderHook(() => useStudioSidebarNavigation(true), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/studio?tenantId=42"]}>
        {children}
      </MemoryRouter>
    ),
  });
  const hasObjects = () =>
    result.current.children.some((child) => child.group === "objects");
  await waitFor(() => expect(hasObjects()).toBe(true));
  const connection = transport.mock.calls
    .map(([options]) => options)
    .find((options) => options.enabled && options.tenantId === 42);
  act(() => connection?.onConnected?.());
  await waitFor(() =>
    expect(mockedServices.apiClient.get).toHaveBeenCalledOnce(),
  );
  const signal = (
    mockedServices.apiClient.get.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
  )[1].signal;
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: "savia-studio-navigation",
          tenantId: 42,
          sessionGeneration: getSessionGeneration(),
          accessDenied: true,
          objects: [],
        },
      }),
    ),
  );
  expect(hasObjects()).toBe(false);
  expect(signal?.aborted).toBe(true);

  await act(async () =>
    finishRead({ data: [{ name: "obsolete", label: "Obsolete data" }] }),
  );
  expect(hasObjects()).toBe(false);
});

it.each([503, 403])(
  "handles a %s from the sidebar collection read without restoring an unauthorized snapshot",
  async (status) => {
    const contacts = {
      name: "hubspot_contacts",
      label: "Confirmed contacts",
      config: { studio: { collection: { kind: "crm", sourceId: "hubspot" } } },
    };
    const recovered = { ...contacts, label: "Rechecked contacts" };
    studioTenants.mockResolvedValue([tenant]);
    mockedServices.localData.cachedMetadata.mockResolvedValueOnce({
      data: [contacts],
    });
    let rejectRead!: (error: ApiClientError) => void;
    const pendingRead = new Promise<never>((_, reject) => {
      rejectRead = reject;
    });
    mockedServices.apiClient.get
      .mockReturnValueOnce(pendingRead)
      .mockResolvedValueOnce({ data: [recovered] });
    const { result } = renderHook(() => useStudioSidebarNavigation(true), {
      wrapper: ({ children }) => (
        <MemoryRouter
          initialEntries={["/studio?tenantId=42&object=hubspot_contacts"]}
        >
          {children}
        </MemoryRouter>
      ),
    });
    const item = () =>
      result.current.children.find(
        (child) => child.id === "object:hubspot_contacts",
      );
    const send = (object: typeof contacts, total: number) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            type: "savia-studio-navigation",
            tenantId: 42,
            sessionGeneration: getSessionGeneration(),
            objects: [object],
            hubspotCount: { name: object.name, total },
          },
        }),
      );
    };
    await waitFor(() => expect(item()?.label).toBe(contacts.label));
    act(() => send(contacts, 6));
    expect(item()?.count).toBe(6);
    const connection = transport.mock.calls
      .map(([options]) => options)
      .find((options) => options.enabled && options.tenantId === 42);

    act(() => connection?.onConnected?.());
    await waitFor(() =>
      expect(mockedServices.apiClient.get).toHaveBeenCalledOnce(),
    );
    await act(async () => {
      rejectRead(
        new ApiClientError(status, "read_failed", "Unable to read collections"),
      );
    });
    if (status === 503) {
      expect(item()).toMatchObject({ label: contacts.label, count: 6 });
    } else {
      expect(item()).toBeUndefined();
      act(() => send(contacts, 99));
      expect(item()).toBeUndefined();
      expect(
        result.current.children.find((child) => child.id === "studio:admin")
          ?.route,
      ).not.toContain("object=");
    }

    await act(async () =>
      window.dispatchEvent(new Event(STUDIO_TENANTS_CHANGED)),
    );
    await waitFor(() => expect(item()?.label).toBe(recovered.label));
    expect(item()?.count).toBe(status === 503 ? 6 : undefined);
    act(() => send(recovered, 10));
    expect(item()?.count).toBe(10);
  },
);
