import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { AppServices } from "@/app-services";
import { ApiClientError } from "@/api/api-client";
import { AppServicesProvider } from "@/features/assistant/assistant-context";
import {
  SaviaRequestProvider,
  useSaviaRequestWorkspace,
} from "./savia-request-provider";
import {
  clearAllSaviaRequestSnapshots,
  writeSaviaRequestSnapshot,
} from "./savia-request-cache";
import type { FlowSummary, RequestFlow } from "./types";
import { rotateSessionScope } from "@/auth/session-scope";

vi.mock("ra-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ra-core")>()),
  useCanAccess: () => ({ canAccess: true, isPending: false }),
}));

const scopeState = {
  scope: undefined as string | undefined,
  label: "Plataforma (catálogo global)",
  ready: true,
  isPlatformAdmin: false,
  canOverride: false,
  options: [] as string[],
  applyOverride: () => undefined,
};

vi.mock("./savia-request-scope", () => ({
  clearCachedTenantOptions: vi.fn(),
  useSaviaRequestScope: () => scopeState,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const autos: RequestFlow = {
  id: "autos",
  name: "Autos",
  description: "",
  input: {},
  variables: [],
  versions: [],
  steps: [
    {
      id: "s1",
      name: "Paso",
      url: "https://provider.test/q",
      method: "GET",
      headers: {},
      body: "{}",
      pre: "",
      post: "",
    },
  ],
};
const hogar: RequestFlow = { ...autos, id: "hogar", name: "Hogar" };
const autosSummary: FlowSummary = {
  id: "autos",
  name: "Autos",
  steps: autos.steps,
} as FlowSummary;
const hogarSummary: FlowSummary = {
  id: "hogar",
  name: "Hogar",
  steps: hogar.steps,
} as FlowSummary;

function Probe({
  navigateTo,
  onReload,
}: {
  navigateTo?: string;
  onReload?: (loaded: boolean) => void;
}) {
  const {
    busy,
    dirty,
    error,
    flow,
    flows,
    folders,
    reloadFlow,
    refreshNavigation,
    saveDraft,
    updateDraft,
  } = useSaviaRequestWorkspace();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="flow-name">{flow?.name ?? "sin flow"}</p>
      <p data-testid="flows-count">{flows.length}</p>
      <p data-testid="folders-count">{folders.length}</p>
      <p data-testid="current-route">{pathname + search}</p>
      <p data-testid="request-busy">{String(busy)}</p>
      <p data-testid="draft-dirty">{String(dirty)}</p>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={() => void reloadFlow().then(onReload)}>
        reload
      </button>
      <button type="button" onClick={() => void saveDraft()}>
        save
      </button>
      <button type="button" onClick={() => void refreshNavigation()}>
        pending navigation
      </button>
      <button
        type="button"
        onClick={() => flow && updateDraft({ ...flow, name: "Local draft" })}
      >
        dirty
      </button>
      <button
        type="button"
        onClick={() => flow && updateDraft({ ...flow, name: "Newer draft" })}
      >
        newer edit
      </button>
      {navigateTo ? (
        <button type="button" onClick={() => navigate(navigateTo)}>
          ir
        </button>
      ) : null}
    </>
  );
}

function servicesWith(apiClient: unknown) {
  return { apiClient } as unknown as AppServices;
}

afterEach(() => {
  cleanup();
  clearAllSaviaRequestSnapshots();
  vi.restoreAllMocks();
});

beforeEach(() => {
  clearAllSaviaRequestSnapshots();
  scopeState.scope = undefined;
});

describe("SaviaRequestProvider concurrencia", () => {
  it.each([false, true])(
    "ignores a late route read after leaving Savia Request with a snapshot = %s",
    async (hasSnapshot) => {
      if (hasSnapshot)
        writeSaviaRequestSnapshot(undefined, {
          flows: [autosSummary],
          folders: [],
          flow: autos,
          stepIndex: 0,
          error: null,
          updatedAt: Date.now(),
        });
      const pendingDetail = deferred<RequestFlow>();
      let detailCalls = 0;
      const get = vi.fn(async (path: string) => {
        if (path.endsWith("/flows")) return [autosSummary];
        if (path.endsWith("/folders")) return [];
        if (path.endsWith("/flows/autos"))
          return ++detailCalls === 1
            ? pendingDetail.promise
            : { ...autos, name: "Fresh Autos" };
        throw new Error(`Unexpected request: ${path}`);
      });
      const bookings = "/bookings?tab=reservations&date=2026-11-25";
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={["/savia-request"]}>
          <AppServicesProvider services={servicesWith({ get })}>
            <SaviaRequestProvider>
              <Probe navigateTo={bookings} />
              <Link to="/savia-request">Return to Savia Request</Link>
            </SaviaRequestProvider>
          </AppServicesProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(detailCalls).toBe(1));
      await user.click(screen.getByRole("button", { name: "ir" }));
      expect(screen.getByTestId("current-route")).toHaveTextContent(bookings);
      await act(async () => {
        pendingDetail.resolve({ ...autos, name: "Stale Autos" });
        await pendingDetail.promise;
      });

      expect(screen.getByTestId("current-route")).toHaveTextContent(bookings);
      expect(screen.getByTestId("flow-name").textContent).toBe(
        hasSnapshot ? "Autos" : "sin flow",
      );
      expect(screen.getByTestId("request-busy")).toHaveTextContent("false");
      await user.click(
        screen.getByRole("link", { name: "Return to Savia Request" }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("flow-name")).toHaveTextContent(
          "Fresh Autos",
        ),
      );
      expect(screen.getByTestId("current-route")).toHaveTextContent(
        "/savia-request?flow=autos&step=0",
      );
    },
  );

  it("clears protected flow state on a 403 and keeps the read retryable", async () => {
    let detailCalls = 0;
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      if (path.endsWith("/flows")) return [autosSummary];
      if (path.endsWith("/folders")) return ["Cotizaciones"];
      if (path.endsWith("/flows/autos")) {
        detailCalls += 1;
        if (detailCalls > 1)
          throw new ApiClientError(403, "forbidden", "Denied");
        return autos;
      }
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={servicesWith({ get })}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
    await user.click(screen.getByRole("button", { name: "reload" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
    expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow");
    expect(screen.getByTestId("flows-count")).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "reload" })).toBeEnabled();
  });

  it("handles a denied folder read while the flow list is still pending", async () => {
    const pendingList = deferred<FlowSummary[]>();
    const pendingFolders = deferred<string[]>();
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/flows")) return pendingList.promise;
      if (path.endsWith("/folders")) return pendingFolders.promise;
      throw new Error(`Unexpected request: ${path}`);
    });
    render(
      <MemoryRouter initialEntries={["/savia-request"]}>
        <AppServicesProvider services={servicesWith({ get })}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/v1/savia-request/api/folders"),
    );
    await act(async () => {
      pendingFolders.reject(
        new ApiClientError(403, "forbidden", "Folder access denied"),
      );
      await pendingFolders.promise.catch(() => undefined);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder access denied",
    );
    expect(screen.getByTestId("request-busy")).toHaveTextContent("false");

    await act(async () => {
      pendingList.resolve([autosSummary]);
      await pendingList.promise;
    });
    expect(screen.getByTestId("flows-count")).toHaveTextContent("0");
    expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow");
    expect(get).not.toHaveBeenCalledWith("/v1/savia-request/api/flows/autos");
  });

  it("retains the current flow after a transient reload failure", async () => {
    let detailCalls = 0;
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      if (path.endsWith("/flows")) return [autosSummary];
      if (path.endsWith("/folders")) return ["Cotizaciones"];
      if (path.endsWith("/flows/autos")) {
        detailCalls += 1;
        if (detailCalls > 1) throw new Error("Temporary network failure");
        return autos;
      }
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={servicesWith({ get })}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
    await user.click(screen.getByRole("button", { name: "dirty" }));
    await user.click(screen.getByRole("button", { name: "reload" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Temporary network failure",
    );
    expect(screen.getByTestId("flow-name")).toHaveTextContent("Local draft");
    expect(screen.getByTestId("flows-count")).toHaveTextContent("1");
  });

  it.each([false, true])(
    "completes a flow detail reload only when the navigation failure is transient (denied = %s)",
    async (denied) => {
      const get = vi.fn(async (path: string) => {
        if (path.endsWith("/flows")) return [autosSummary];
        if (path.endsWith("/folders")) return [];
        if (path.endsWith("/flows/autos")) return autos;
        throw new Error(`Unexpected request: ${path}`);
      });
      const user = userEvent.setup();
      const onReload = vi.fn();
      render(
        <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
          <AppServicesProvider services={servicesWith({ get })}>
            <SaviaRequestProvider>
              <Probe onReload={onReload} />
            </SaviaRequestProvider>
          </AppServicesProvider>
        </MemoryRouter>,
      );
      expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
      get.mockResolvedValueOnce({ ...autos, name: "Fresh Autos" });
      get.mockRejectedValueOnce(
        denied
          ? new ApiClientError(403, "FORBIDDEN", "Navigation denied")
          : new Error("Navigation refresh interrupted"),
      );

      await user.click(screen.getByRole("button", { name: "reload" }));

      expect(onReload).toHaveBeenCalledWith(!denied);
      expect(screen.getByTestId("flow-name")).toHaveTextContent(
        denied ? "sin flow" : "Fresh Autos",
      );
      if (denied)
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Navigation denied",
        );
      else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each([
    { deniedResource: "folders", status: 403 },
    { deniedResource: "flows", status: 401 },
  ])(
    "handles a late $status from $deniedResource after the other list fails",
    async ({ deniedResource, status }) => {
      const pendingDenial = deferred<never>();
      const fresh = { ...autos, name: "Fresh Autos" };
      let reloading = false;
      const get = vi.fn(async (path: string) => {
        if (path.endsWith("/flows/autos")) return reloading ? fresh : autos;
        if (reloading) {
          if (path.endsWith(`/${deniedResource}`)) return pendingDenial.promise;
          throw new Error("Temporary list failure");
        }
        if (path.endsWith("/flows")) return [autosSummary];
        if (path.endsWith("/folders")) return ["Cotizaciones"];
        throw new Error(`Unexpected request: ${path}`);
      });
      const user = userEvent.setup();
      const onReload = vi.fn();
      render(
        <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
          <AppServicesProvider services={servicesWith({ get })}>
            <SaviaRequestProvider>
              <Probe onReload={onReload} />
            </SaviaRequestProvider>
          </AppServicesProvider>
        </MemoryRouter>,
      );
      expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");

      reloading = true;
      await user.click(screen.getByRole("button", { name: "reload" }));
      expect(onReload).toHaveBeenCalledWith(true);
      expect(screen.getByTestId("flow-name")).toHaveTextContent("Fresh Autos");

      await act(async () => {
        pendingDenial.reject(
          new ApiClientError(status, "DENIED", "Workspace access denied"),
        );
        await pendingDenial.promise.catch(() => undefined);
      });

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Workspace access denied",
      );
      expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow");
      expect(screen.getByTestId("flows-count")).toHaveTextContent("0");
      expect(screen.getByTestId("folders-count")).toHaveTextContent("0");
    },
  );

  it.each(["flow=autos&step=0", "view=secretos"])(
    "clears the retained workspace after a late denial on %s",
    async (query) => {
      writeSaviaRequestSnapshot(undefined, {
        flows: [autosSummary],
        folders: ["Cotizaciones"],
        flow: autos,
        stepIndex: 0,
        error: null,
        updatedAt: Date.now(),
      });
      const pendingFolders = deferred<string[]>();
      const get = vi.fn(async (path: string) => {
        if (path.endsWith("/folders")) return pendingFolders.promise;
        throw new Error("Temporary list failure");
      });
      render(
        <MemoryRouter initialEntries={[`/savia-request?${query}`]}>
          <AppServicesProvider services={servicesWith({ get })}>
            <SaviaRequestProvider>
              <Probe />
            </SaviaRequestProvider>
          </AppServicesProvider>
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(get).toHaveBeenCalledWith("/v1/savia-request/api/folders"),
      );
      expect(screen.getByTestId("flow-name")).toHaveTextContent("Autos");

      await act(async () => {
        pendingFolders.reject(
          new ApiClientError(403, "DENIED", "Folder access denied"),
        );
        await pendingFolders.promise.catch(() => undefined);
      });

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Folder access denied",
      );
      expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow");
      expect(screen.getByTestId("flows-count")).toHaveTextContent("0");
      expect(screen.getByTestId("folders-count")).toHaveTextContent("0");
    },
  );

  it("keeps a dirty draft after a write-only 403", async () => {
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      if (path.endsWith("/flows")) return [autosSummary];
      if (path.endsWith("/folders")) return ["Cotizaciones"];
      if (path.endsWith("/flows/autos")) return autos;
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    const put = vi.fn(async () => {
      throw new ApiClientError(403, "forbidden", "Write denied");
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={servicesWith({ get, put })}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
    await user.click(screen.getByRole("button", { name: "dirty" }));
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Write denied");
    expect(screen.getByTestId("flow-name")).toHaveTextContent("Local draft");
    expect(screen.getByTestId("flows-count")).toHaveTextContent("1");
  });

  it("keeps edits made while an earlier version of the draft is saving", async () => {
    const pendingSave = deferred<{ ok: true }>();
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/flows")) return [autosSummary];
      if (path.endsWith("/folders")) return [];
      if (path.endsWith("/flows/autos")) return autos;
      throw new Error(`Unexpected request: ${path}`);
    });
    const put = vi
      .fn()
      .mockReturnValueOnce(pendingSave.promise)
      .mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={servicesWith({ get, put })}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
    await user.click(screen.getByRole("button", { name: "dirty" }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(put).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos",
      expect.objectContaining({ name: "Local draft" }),
    );
    await user.click(screen.getByRole("button", { name: "newer edit" }));

    await act(async () => {
      pendingSave.resolve({ ok: true });
      await pendingSave.promise;
    });
    expect(screen.getByTestId("flow-name")).toHaveTextContent("Newer draft");
    expect(screen.getByTestId("draft-dirty")).toHaveTextContent("true");
    expect(screen.getByTestId("request-busy")).toHaveTextContent("false");

    await user.click(screen.getByRole("button", { name: "save" }));
    expect(put).toHaveBeenLastCalledWith(
      "/v1/savia-request/api/flows/autos",
      expect.objectContaining({ name: "Newer draft" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("draft-dirty")).toHaveTextContent("false"),
    );
  });

  it.each(["succeeds", "fails", "is denied during reload"])(
    "preserves the new tenant's draft and pending save when the previous tenant action %s",
    async (outcome) => {
      const previousAction = deferred<{ ok: true } | RequestFlow>();
      const currentSave = deferred<{ ok: true }>();
      let deferReload = false;
      const get = vi.fn(async (raw: string) => {
        const [path, query] = raw.split("?");
        const newScope =
          new URLSearchParams(query).get("tenant") === "tenant:99";
        if (path.endsWith("/flows"))
          return newScope ? [hogarSummary] : [autosSummary];
        if (path.endsWith("/folders"))
          return [newScope ? "New folder" : "Old folder"];
        if (path.endsWith("/flows/autos"))
          return deferReload ? previousAction.promise : autos;
        if (path.endsWith("/flows/hogar")) return hogar;
        throw new Error(`Unexpected request: ${raw}`);
      });
      const put = vi.fn((path: string) =>
        path.includes("tenant=tenant%3A99")
          ? currentSave.promise
          : previousAction.promise,
      );
      const services = servicesWith({ get, put });
      const renderTree = () => (
        <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
          <AppServicesProvider services={services}>
            <SaviaRequestProvider>
              <Probe />
            </SaviaRequestProvider>
          </AppServicesProvider>
        </MemoryRouter>
      );
      const user = userEvent.setup();
      const { rerender } = render(renderTree());
      expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
      await user.click(screen.getByRole("button", { name: "dirty" }));
      deferReload = outcome === "is denied during reload";
      await user.click(
        screen.getByRole("button", { name: deferReload ? "reload" : "save" }),
      );
      expect(screen.getByTestId("request-busy")).toHaveTextContent("true");

      scopeState.scope = "tenant:99";
      rerender(renderTree());
      await waitFor(() =>
        expect(screen.getByTestId("flow-name")).toHaveTextContent("Hogar"),
      );
      await user.click(screen.getByRole("button", { name: "newer edit" }));
      await user.click(screen.getByRole("button", { name: "save" }));
      expect(put).toHaveBeenLastCalledWith(
        "/v1/savia-request/api/flows/hogar?tenant=tenant%3A99",
        expect.objectContaining({ name: "Newer draft" }),
      );
      const readCount = get.mock.calls.length;

      await act(async () => {
        if (outcome === "succeeds") previousAction.resolve({ ok: true });
        else
          previousAction.reject(
            new ApiClientError(403, "forbidden", "Previous tenant denied"),
          );
        await previousAction.promise.catch(() => undefined);
      });
      expect(screen.getByTestId("flow-name")).toHaveTextContent("Newer draft");
      expect(screen.getByTestId("draft-dirty")).toHaveTextContent("true");
      expect(screen.getByTestId("request-busy")).toHaveTextContent("true");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(get).toHaveBeenCalledTimes(readCount);

      await act(async () => {
        currentSave.resolve({ ok: true });
        await currentSave.promise;
      });
      expect(screen.getByTestId("draft-dirty")).toHaveTextContent("false");
      expect(screen.getByTestId("request-busy")).toHaveTextContent("false");
    },
  );

  it("does not restore navigation after a denied read", async () => {
    const pendingFlows = deferred<FlowSummary[]>();
    const pendingFolders = deferred<string[]>();
    let flowCalls = 0;
    let folderCalls = 0;
    let detailCalls = 0;
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      if (path.endsWith("/flows")) {
        flowCalls += 1;
        return flowCalls === 1 ? [autosSummary] : pendingFlows.promise;
      }
      if (path.endsWith("/folders")) {
        folderCalls += 1;
        return folderCalls === 1 ? ["Cotizaciones"] : pendingFolders.promise;
      }
      if (path.endsWith("/flows/autos")) {
        detailCalls += 1;
        if (detailCalls > 1)
          throw new ApiClientError(403, "forbidden", "Denied");
        return autos;
      }
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={servicesWith({ get })}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
    await user.click(
      screen.getByRole("button", { name: "pending navigation" }),
    );
    await waitFor(() => {
      expect(flowCalls).toBe(2);
      expect(folderCalls).toBe(2);
    });
    await user.click(screen.getByRole("button", { name: "reload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
    expect(screen.getByTestId("flows-count")).toHaveTextContent("0");

    pendingFlows.resolve([autosSummary]);
    pendingFolders.resolve(["Stale folder"]);
    await waitFor(() =>
      expect(screen.getByTestId("flows-count")).toHaveTextContent("0"),
    );
    expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow");
  });

  it.each(["success", "denial"])(
    "ignores an old-scope navigation %s after a tenant switch",
    async (outcome) => {
      const pendingFlows = deferred<FlowSummary[]>();
      const pendingFolders = deferred<string[]>();
      let flowCalls = 0;
      let folderCalls = 0;
      const get = vi.fn(async (raw: string) => {
        const path = raw.split("?")[0];
        if (raw.includes("tenant=tenant%3A99")) {
          if (path.endsWith("/flows")) return [hogarSummary];
          if (path.endsWith("/folders")) return ["New folder", "Other folder"];
          if (path.endsWith("/flows/hogar")) return hogar;
        }
        if (path.endsWith("/flows")) {
          flowCalls += 1;
          return flowCalls === 1 ? [autosSummary] : pendingFlows.promise;
        }
        if (path.endsWith("/folders")) {
          folderCalls += 1;
          return folderCalls === 1
            ? ["Old tenant folder"]
            : pendingFolders.promise;
        }
        if (path.endsWith("/flows/autos")) return autos;
        throw new Error(`Ruta inesperada: ${raw}`);
      });
      const services = servicesWith({ get });
      const user = userEvent.setup();
      const renderTree = () => (
        <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
          <AppServicesProvider services={services}>
            <SaviaRequestProvider>
              <Probe />
            </SaviaRequestProvider>
          </AppServicesProvider>
        </MemoryRouter>
      );
      const { rerender } = render(renderTree());

      expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
      await user.click(
        screen.getByRole("button", { name: "pending navigation" }),
      );
      await waitFor(() => {
        expect(flowCalls).toBe(2);
        expect(folderCalls).toBe(2);
      });

      scopeState.scope = "tenant:99";
      rerender(renderTree());
      await waitFor(() =>
        expect(screen.getByTestId("flow-name")).toHaveTextContent("Hogar"),
      );
      await act(async () => {
        pendingFlows.resolve([autosSummary, { ...autosSummary, id: "stale" }]);
        if (outcome === "denial")
          pendingFolders.reject(
            new ApiClientError(403, "DENIED", "Previous tenant denied"),
          );
        else pendingFolders.resolve(["Stale old tenant folder"]);
        await Promise.allSettled([
          pendingFlows.promise,
          pendingFolders.promise,
        ]);
      });
      expect(screen.getByTestId("flows-count")).toHaveTextContent("1");
      expect(screen.getByTestId("folders-count")).toHaveTextContent("2");
      expect(screen.getByTestId("flow-name")).toHaveTextContent("Hogar");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("ignora la respuesta tardía del flow anterior al navegar rápido", async () => {
    const user = userEvent.setup();
    const flowsFirst = deferred<FlowSummary[]>();
    const foldersFirst = deferred<string[]>();
    const autosDetail = deferred<RequestFlow>();
    let flowsCalls = 0;
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      if (path.endsWith("/flows")) {
        flowsCalls += 1;
        return flowsCalls === 1
          ? flowsFirst.promise
          : [autosSummary, hogarSummary];
      }
      if (path.endsWith("/folders")) {
        return foldersFirst.promise;
      }
      if (path.endsWith("/flows/autos")) return autosDetail.promise;
      if (path.endsWith("/flows/hogar")) return hogar;
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={servicesWith({ get })}>
          <SaviaRequestProvider>
            <Probe navigateTo="/savia-request?flow=hogar&step=0" />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    foldersFirst.resolve(["Cotizaciones"]);
    flowsFirst.resolve([autosSummary, hogarSummary]);
    // Deja que el primer efecto pida el detalle de autos (lento).
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("/flows/autos")),
    );
    await user.click(screen.getByRole("button", { name: "ir" }));
    expect(await screen.findByTestId("flow-name")).toHaveTextContent("Hogar");
    // La respuesta tardía de autos no reemplaza a hogar.
    autosDetail.resolve(autos);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("flow-name")).toHaveTextContent("Hogar");
  });

  it("muestra el detalle sin esperar a carpetas lentas", async () => {
    const foldersSlow = deferred<string[]>();
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      if (path.endsWith("/flows")) return [autosSummary];
      if (path.endsWith("/folders")) return foldersSlow.promise;
      if (path.endsWith("/flows/autos")) return autos;
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={servicesWith({ get })}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
    foldersSlow.resolve(["Cotizaciones"]);
  });

  it("limpia al cambiar de tenant e ignora lo tardío del ámbito anterior", async () => {
    const autosDetail = deferred<RequestFlow>();
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      // El tenant nuevo no ve el catálogo de plataforma en este mock.
      if (raw.includes("tenant=")) {
        if (path.endsWith("/flows")) return [];
        if (path.endsWith("/folders")) return [];
        throw new Error(`Detalle inesperado en tenant: ${raw}`);
      }
      if (path.endsWith("/flows")) return [autosSummary];
      if (path.endsWith("/folders")) return ["C"];
      if (path.endsWith("/flows/autos")) return autosDetail.promise;
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    const services = servicesWith({ get });
    const { rerender } = render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={services}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("/flows/autos")),
    );

    scopeState.scope = "tenant:99";
    rerender(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={services}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );
    // Limpieza inmediata del ámbito anterior.
    await waitFor(() =>
      expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow"),
    );
    autosDetail.resolve(autos);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow");
    // El nuevo ámbito consulta con su tenant.
    expect(get).toHaveBeenCalledWith(expect.stringContaining("tenant="));
  });

  it("revalida una sola vez al regresar y sincroniza la URL", async () => {
    writeSaviaRequestSnapshot(undefined, {
      flows: [autosSummary],
      folders: ["Cotizaciones"],
      flow: autos,
      stepIndex: 1,
      error: null,
      updatedAt: Date.now(),
    });
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      if (path.endsWith("/flows")) return [autosSummary, hogarSummary];
      if (path.endsWith("/folders")) return ["Cotizaciones"];
      if (path.endsWith("/flows/autos")) return autos;
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    render(
      <MemoryRouter initialEntries={["/savia-request"]}>
        <AppServicesProvider services={servicesWith({ get })}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    // Contenido conservado visible de inmediato...
    expect(await screen.findByTestId("flow-name")).toHaveTextContent("Autos");
    // ...y la URL refleja la selección tras revalidar una sola vez.
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("/folders")),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const flowCalls = get.mock.calls.filter(([path]) =>
      (path as string).split("?")[0].endsWith("/flows"),
    );
    expect(flowCalls).toHaveLength(1);
  });

  it("ignores pending detail after principal rotation", async () => {
    const oldDetail = deferred<RequestFlow>();
    let flowListCalls = 0;
    const getIdentity = vi
      .fn()
      .mockResolvedValueOnce({ id: "old-principal" })
      .mockResolvedValueOnce({ id: "new-principal" });
    const get = vi.fn(async (raw: string) => {
      const path = raw.split("?")[0];
      if (path.endsWith("/flows")) {
        flowListCalls += 1;
        return flowListCalls === 1 ? [autosSummary] : [];
      }
      if (path.endsWith("/folders")) return ["Cotizaciones"];
      if (path.endsWith("/flows/autos")) return oldDetail.promise;
      throw new Error(`Ruta inesperada: ${raw}`);
    });
    const services = {
      ...servicesWith({ get }),
      authSession: { getIdentity },
    } as unknown as AppServices;
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={services}>
          <SaviaRequestProvider>
            <Probe />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("/flows/autos")),
    );
    rotateSessionScope("principal-change");
    await waitFor(() => expect(flowListCalls).toBe(2));
    await waitFor(() =>
      expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow"),
    );

    oldDetail.resolve(autos);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("flow-name")).toHaveTextContent("sin flow");
    expect(getIdentity).toHaveBeenCalledTimes(2);
  });
});
