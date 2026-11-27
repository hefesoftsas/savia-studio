import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalSession,
  clearSessionCache,
  readWorkspaceMetadata,
  removeWorkspaceMetadata,
  removeWorkspacePluginMetadata,
  writeWorkspaceMetadata,
} from "./session";
import type { AuthSession } from "@/auth/auth-session";
const permissions = {
  canReadDocuments: true,
  canExecuteCommands: true,
  canManageIdentity: false,
  memberships: [{ agencyId: 1, role: "operator" }],
};
function remote() {
  return {
    getIdentity: vi.fn().mockResolvedValue({ id: "a", fullName: "A" }),
    getPermissions: vi.fn().mockResolvedValue(permissions),
    checkSession: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getAuthorizeUrl: () => "/login",
    getAccessToken: vi.fn(),
    handleCallback: vi.fn(),
  } as unknown as AuthSession;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await clearSessionCache("test");
});
describe("offline workspace session lease", () => {
  it("restores provisioned identity offline without persisting tokens", async () => {
    const session = createLocalSession(remote(), "test");
    await session.checkSession();
    const next = remote();
    vi.mocked(next.checkSession).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    vi.mocked(next.getIdentity).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    vi.mocked(next.getPermissions).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const restored = createLocalSession(next, "test");
    await expect(restored.checkSession()).resolves.toBeUndefined();
    expect((await restored.getIdentity()).id).toBe("a");
    expect(await restored.getPermissions()).toEqual(permissions);
  });
  it("does not turn a rejected server session into offline access", async () => {
    await createLocalSession(remote(), "test").checkSession();
    const next = remote();
    vi.mocked(next.checkSession).mockRejectedValue({ status: 401 });
    await expect(
      createLocalSession(next, "test").checkSession(),
    ).rejects.toEqual({ status: 401 });
    vi.mocked(next.checkSession).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    await expect(
      createLocalSession(next, "test").checkSession(),
    ).rejects.toBeDefined();
  });
  it("explicit logout invalidates offline access", async () => {
    const session = createLocalSession(remote(), "test");
    await session.checkSession();
    await session.clearSession();
    const next = remote();
    vi.mocked(next.checkSession).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    await expect(
      createLocalSession(next, "test").checkSession(),
    ).rejects.toBeDefined();
  });

  it.each(["the same tab", "another tab"])(
    "rejects an offline lease whose online verification completes after logout in %s",
    async (tab) => {
      const api = remote();
      let enteredVerification!: () => void;
      const verifying = new Promise<void>((resolve) => {
        enteredVerification = resolve;
      });
      let finishVerification!: () => void;
      const proof = () =>
        new Promise<void>((resolve) => {
          finishVerification = resolve;
          enteredVerification();
        });
      const session = createLocalSession(api, "test", proof);
      const verification = session.checkSession().then(
        () => "accepted",
        () => "invalidated",
      );
      await verifying;

      const signingOut =
        tab === "the same tab" ? session : createLocalSession(remote(), "test");
      await signingOut.logout();
      finishVerification();

      expect(await verification).toBe("invalidated");
      const offline = remote();
      vi.mocked(offline.checkSession).mockRejectedValue(
        new TypeError("Failed to fetch"),
      );
      await expect(
        createLocalSession(offline, "test").checkSession(),
      ).rejects.toThrow("Conecta para verificar");
    },
  );

  it("preserves a new session when verification from before logout fails late", async () => {
    const api = remote();
    let failOldProof!: (reason: Error) => void;
    const oldProof = new Promise<void>((_, reject) => (failOldProof = reject));
    const proof = vi
      .fn()
      .mockReturnValueOnce(oldProof)
      .mockResolvedValue(undefined);
    const session = createLocalSession(api, "test", proof);
    const oldCheck = session.checkSession().catch(() => undefined);
    await vi.waitFor(() => expect(proof).toHaveBeenCalledOnce());

    await session.clearSession();
    vi.mocked(api.getIdentity).mockResolvedValue({ id: "b", fullName: "B" });
    await session.handleCallback();
    failOldProof(new Error("Old session was rejected"));
    await oldCheck;

    const offline = remote();
    vi.mocked(offline.getIdentity).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const restored = createLocalSession(offline, "test");
    await expect(restored.getIdentity()).resolves.toMatchObject({ id: "b" });
  });

  it.each(["succeeds", "fails", "loses connectivity"])(
    "preserves a newer tab's lease when an older authentication check %s after logout",
    async (outcome) => {
      const api = remote();
      let finishCheck!: () => void;
      vi.mocked(api.checkSession).mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            finishCheck = () => {
              if (outcome === "succeeds") resolve();
              else if (outcome === "loses connectivity")
                reject(new TypeError("Failed to fetch"));
              else reject(new Error("Previous session rejected"));
            };
          }),
      );
      const oldTab = createLocalSession(api, "test");
      const staleCheck = oldTab.checkSession().then(
        () => "accepted",
        () => "invalidated",
      );
      await vi.waitFor(() => expect(api.checkSession).toHaveBeenCalledOnce());

      const next = remote();
      const newTab = createLocalSession(next, "test");
      await newTab.logout();
      vi.mocked(next.getIdentity).mockResolvedValue({ id: "b", fullName: "B" });
      await newTab.handleCallback();
      finishCheck();

      expect(await staleCheck).toBe("invalidated");
      const offline = remote();
      vi.mocked(offline.getIdentity).mockRejectedValue(
        new TypeError("Failed to fetch"),
      );
      await expect(
        createLocalSession(offline, "test").getIdentity(),
      ).resolves.toMatchObject({ id: "b" });
    },
  );
});

it("keeps authenticated online sessions working when IndexedDB writes fail", async () => {
  const api = remote();
  const failure = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(() => {
      throw new DOMException("Disk full", "QuotaExceededError");
    });
  const session = createLocalSession(api, "test");
  await expect(session.checkSession()).resolves.toBeUndefined();
  await expect(session.handleCallback()).resolves.toBeUndefined();
  expect(api.clearSession).not.toHaveBeenCalled();
  failure.mockRestore();
});
it("still clears the remote session when IndexedDB revocation fails", async () => {
  const api = remote();
  const session = createLocalSession(api, "test");
  await session.checkSession();
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
    throw new DOMException("Unavailable", "UnknownError");
  });
  vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(() => {
    throw new DOMException("Unavailable", "UnknownError");
  });
  await expect(session.clearSession()).resolves.toBeUndefined();
  expect(api.clearSession).toHaveBeenCalled();
});

it("does not renew or bypass an expired lease when remote checkSession silently uses cached credentials", async () => {
  const api = remote();
  const proof = vi.fn().mockResolvedValue(undefined);
  const session = createLocalSession(api, "test", proof);
  await session.checkSession();
  proof.mockRejectedValue(new TypeError("Failed to fetch"));
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 60 * 1000);
  await expect(session.checkSession()).resolves.toBeUndefined();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
  await expect(session.checkSession()).rejects.toThrow(
    "Conecta para verificar",
  );
  await expect(session.getIdentity()).rejects.toThrow("Conecta para verificar");
  await expect(session.getPermissions()).rejects.toThrow(
    "Conecta para verificar",
  );
});

it("observes another tab clearing the persisted lease instead of trusting its in-memory copy", async () => {
  const api = remote();
  const session = createLocalSession(api, "test");
  await session.checkSession();
  await clearSessionCache("test");
  vi.mocked(api.checkSession).mockRejectedValue(
    new TypeError("Failed to fetch"),
  );
  await expect(session.checkSession()).rejects.toThrow(
    "Conecta para verificar",
  );
});

it("coalesces concurrent ensureLease calls when verifying remote credentials", async () => {
  const api = remote();
  const proof = vi.fn().mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const session = createLocalSession(api, "test", proof);

  const [id1, id2, id3] = await Promise.all([
    session.getIdentity(),
    session.getIdentity(),
    session.getIdentity(),
  ]);

  expect(id1.id).toBe("a");
  expect(id2.id).toBe("a");
  expect(id3.id).toBe("a");
  expect(proof).toHaveBeenCalledTimes(1);
});

it("plugin development invalidation clears current-principal transport caches only", async () => {
  const principal = JSON.stringify(["test-api", "plugin-user"]);
  const transport = JSON.stringify([principal, "/api", { canRead: true }]);
  const otherPrincipal = JSON.stringify(["test-api", "another-user"]);
  const keys = [
    `${principal}:local-catalog`,
    `${transport}:metadata:/api/objects`,
    `${transport}:metadata:/api/extensions`,
    `${transport}:objects`,
    `${JSON.stringify([otherPrincipal, "/api", {}])}:metadata:/api/objects`,
  ];
  await Promise.all(keys.map((key) => writeWorkspaceMetadata(key, key)));

  await removeWorkspacePluginMetadata(principal);

  for (const key of keys.slice(0, 4))
    expect(await readWorkspaceMetadata(key)).toBeUndefined();
  expect(await readWorkspaceMetadata(keys[4])).toBe(keys[4]);
  await Promise.all(keys.map((key) => removeWorkspaceMetadata(key)));
});
