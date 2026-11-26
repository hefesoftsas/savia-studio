// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { subscribeOnlineStatus } from "../offline/connectivity-status";
import {
  registerPwaServiceWorker,
  retireAdministrativeWorkerForPublicRoute,
} from "./register-service-worker";

const stopObservers: Array<() => void> = [];
function observeUpdates() {
  const stop = registerPwaServiceWorker();
  if (stop) stopObservers.push(stop);
  return stop;
}

afterEach(() => {
  for (const stop of stopObservers.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("registers after lazy private bootstrap even when window load already fired", async () => {
  const register = vi.fn().mockResolvedValue({
    scope: "/",
    update: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
  observeUpdates();
  expect(register).toHaveBeenCalledOnce();
});
it("waits for load while the private page is still loading", () => {
  const register = vi.fn().mockResolvedValue({
    scope: "/",
    update: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
  observeUpdates();
  expect(register).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("load"));
  window.dispatchEvent(new Event("load"));
  expect(register).toHaveBeenCalledOnce();
});

it("cancels registration when its observer closes before the page loads", () => {
  const register = vi.fn().mockResolvedValue({
    scope: "/",
    update: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
  observeUpdates()?.();
  window.dispatchEvent(new Event("load"));
  expect(register).not.toHaveBeenCalled();
});

it("ignores a registration that finishes after its observer closes", async () => {
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const update = vi.fn().mockResolvedValue(undefined);
  const registration = { scope: "/", update };
  let finishRegistration!: (value: typeof registration) => void;
  const register = vi.fn(
    () =>
      new Promise<typeof registration>((resolve) => {
        finishRegistration = resolve;
      }),
  );
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
  observeUpdates()?.();
  finishRegistration(registration);
  await Promise.resolve();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(update).not.toHaveBeenCalled();
});

it("shares registration across a remount and removes version checks on cleanup", async () => {
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const update = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn().mockResolvedValue({ scope: "/", update });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
  observeUpdates()?.();
  const stop = observeUpdates();
  expect(register).toHaveBeenCalledOnce();
  await Promise.resolve();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(update).toHaveBeenCalledOnce();

  stop?.();
  clock.mockReturnValue(60_000);
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(update).toHaveBeenCalledOnce();
});

it("checks for updates on reconnect and visibility with a one-minute throttle", async () => {
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const update = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn().mockResolvedValue({ scope: "/", update });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
  observeUpdates();
  await Promise.resolve();
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(update).toHaveBeenCalledOnce();
  expect(register).toHaveBeenCalledWith(expect.any(String), {
    scope: "/",
    updateViaCache: "none",
  });
});

it("checks for updates after verifying connectivity despite a browser offline hint", async () => {
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const update = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn().mockResolvedValue({ scope: "/", update });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
  observeUpdates();
  await Promise.resolve();
  const release = subscribeOnlineStatus(() => {});
  try {
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce(), {
      timeout: 300,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(navigator.onLine).toBe(false);
    expect(update).toHaveBeenCalledOnce();
  } finally {
    release();
  }
});

it.each(["tab hides", "observer closes"])(
  "cancels background verification when the %s",
  async (reason) => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    let finishProbe!: (response: Response) => void;
    const fetcher = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          finishProbe = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const update = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({ scope: "/", update });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
    const stop = observeUpdates();
    await Promise.resolve();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce(), {
      timeout: 300,
    });
    if (reason === "tab hides") {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    } else stop?.();
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    finishProbe(new Response(null));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(update).not.toHaveBeenCalled();
  },
);

it("unregisters an existing admin worker and reloads public visitor routes", async () => {
  const controller = { scriptURL: `${window.location.origin}/sw.js` };
  const unregister = vi.fn().mockResolvedValue(true);
  const registration = {
    scope: `${window.location.origin}/`,
    active: controller,
    installing: null,
    waiting: null,
    unregister,
  };
  const getRegistration = vi.fn().mockResolvedValue(registration);
  const reload = vi.fn();

  await retireAdministrativeWorkerForPublicRoute(
    "/public/quotes/" + "a".repeat(64),
    { controller, getRegistration } as unknown as ServiceWorkerContainer,
    reload,
  );

  expect(getRegistration).toHaveBeenCalledWith("/");
  expect(unregister).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
});

it("leaves first-time public visitors and unrelated service workers alone", async () => {
  const reload = vi.fn();
  const getRegistration = vi.fn();
  await retireAdministrativeWorkerForPublicRoute(
    "/public/quotes/" + "a".repeat(64),
    { controller: null, getRegistration } as unknown as ServiceWorkerContainer,
    reload,
  );
  await retireAdministrativeWorkerForPublicRoute(
    "/public/quotes/" + "a".repeat(64),
    {
      controller: {
        scriptURL: `${window.location.origin}/other-worker.js`,
      },
      getRegistration,
    } as unknown as ServiceWorkerContainer,
    reload,
  );
  await retireAdministrativeWorkerForPublicRoute(
    "/private",
    {
      controller: { scriptURL: `${window.location.origin}/sw.js` },
      getRegistration,
    } as unknown as ServiceWorkerContainer,
    reload,
  );
  expect(getRegistration).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("does not reload when unregister reports that the registration remains", async () => {
  const controller = { scriptURL: `${window.location.origin}/sw.js` };
  const registration = {
    scope: `${window.location.origin}/`,
    active: controller,
    unregister: vi.fn().mockResolvedValue(false),
  };
  const reload = vi.fn();
  await retireAdministrativeWorkerForPublicRoute(
    "/public/quotes/" + "b".repeat(64),
    {
      controller,
      getRegistration: vi.fn().mockResolvedValue(registration),
    } as unknown as ServiceWorkerContainer,
    reload,
  );
  expect(registration.unregister).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
});

it("bounds a stalled service-worker lookup and releases its retry guard", async () => {
  vi.useFakeTimers();
  try {
    const controller = { scriptURL: `${window.location.origin}/sw.js` };
    const getRegistration = vi.fn().mockReturnValue(new Promise(() => {}));
    const serviceWorker = {
      controller,
      getRegistration,
    } as unknown as ServiceWorkerContainer;
    const reload = vi.fn();
    const retirement = retireAdministrativeWorkerForPublicRoute(
      "/public/quotes/" + "c".repeat(64),
      serviceWorker,
      reload,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(retirement).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    getRegistration.mockResolvedValue({
      scope: `${window.location.origin}/`,
      active: controller,
      unregister: vi.fn().mockResolvedValue(true),
    });
    await expect(
      retireAdministrativeWorkerForPublicRoute(
        "/public/quotes/" + "c".repeat(64),
        serviceWorker,
        reload,
      ),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("does not unregister later when a timed-out registration lookup resolves", async () => {
  vi.useFakeTimers();
  try {
    const controller = { scriptURL: `${window.location.origin}/sw.js` };
    let resolveRegistration!: (registration: unknown) => void;
    const getRegistration = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRegistration = resolve;
        }),
    );
    const reload = vi.fn();
    const retirement = retireAdministrativeWorkerForPublicRoute(
      "/public/quotes/" + "d".repeat(64),
      { controller, getRegistration } as unknown as ServiceWorkerContainer,
      reload,
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(retirement).resolves.toBe(false);

    const unregister = vi.fn().mockResolvedValue(true);
    resolveRegistration({
      scope: `${window.location.origin}/`,
      active: controller,
      unregister,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(unregister).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("reloads once if unregistration succeeds after the five-second deadline", async () => {
  vi.useFakeTimers();
  try {
    const controller = { scriptURL: `${window.location.origin}/sw.js` };
    let resolveUnregister!: (value: boolean) => void;
    const unregister = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveUnregister = resolve;
        }),
    );
    const reload = vi.fn();
    const retirement = retireAdministrativeWorkerForPublicRoute(
      "/public/quotes/" + "e".repeat(64),
      {
        controller,
        getRegistration: vi.fn().mockResolvedValue({
          scope: `${window.location.origin}/`,
          active: controller,
          unregister,
        }),
      } as unknown as ServiceWorkerContainer,
      reload,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(unregister).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(retirement).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();

    resolveUnregister(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
