import Dexie, { type Table } from "dexie";
import type { UserIdentity } from "ra-core";
import type { AuthSession, AuthPermissions } from "@/auth/auth-session";
import { isOfflineError } from "@/offline/offline-error";

const LEASE_MS = 12 * 60 * 60 * 1000;
type Profile = {
  environment: string;
  identity: UserIdentity;
  permissions: AuthPermissions;
  expiresAt: number;
};
type ProfileRecord =
  | (Profile & { revocationId?: string })
  | { environment: string; revocationId: string };
type Metadata = { key: string; value: unknown };
class SessionDb extends Dexie {
  profiles!: Table<ProfileRecord, string>;
  metadata!: Table<Metadata, string>;
  constructor() {
    super("savia-workspaces");
    this.version(1).stores({ profiles: "environment", metadata: "key" });
  }
}
let database: SessionDb | undefined;
const db = () => (database ??= new SessionDb());
export async function clearSessionCache(
  environment: string,
  expectedRevision?: string | null,
) {
  if (typeof indexedDB === "undefined") return;
  const update = async (marker?: ProfileRecord) => {
    const storage = db();
    await storage.transaction("rw", storage.profiles, async () => {
      // A rejected check can revoke only the state it originally read.
      if (expectedRevision !== undefined) {
        const current = await storage.profiles.get(environment);
        if ((current?.revocationId ?? null) !== expectedRevision) return;
      }
      if (marker) await storage.profiles.put(marker);
      else await storage.profiles.delete(environment);
    });
  };
  try {
    // Replace the cached identity with a marker that other tabs can detect.
    await update({ environment, revocationId: crypto.randomUUID() });
  } catch {
    try {
      await update();
    } catch {
      /* Cache availability must not block logout. */
    }
  }
}

async function readProfileRecord(environment: string) {
  if (typeof indexedDB === "undefined") return undefined;
  try {
    return (await db().profiles.get(environment)) ?? null;
  } catch {
    return undefined;
  }
}

class StaleLeaseError extends Error {
  constructor() {
    super("The authenticated session changed during the offline lease check.");
  }
}

type LeaseSnapshot = {
  started: number;
  // null represents an empty store and undefined means it could not be read.
  record: ProfileRecord | null | undefined;
};

function revisionOf(record: LeaseSnapshot["record"]) {
  return record === undefined ? undefined : (record?.revocationId ?? null);
}

function wasRevoked(
  previous: LeaseSnapshot["record"],
  current: LeaseSnapshot["record"],
): boolean {
  return (
    previous !== undefined &&
    current !== undefined &&
    ((previous !== null && current === null) ||
      revisionOf(previous) !== revisionOf(current))
  );
}

export async function readWorkspaceMetadata<T>(
  key: string,
): Promise<T | undefined> {
  if (typeof indexedDB === "undefined") return;
  try {
    return (await db().metadata.get(key))?.value as T | undefined;
  } catch {
    return undefined;
  }
}
export async function writeWorkspaceMetadata(key: string, value: unknown) {
  if (typeof indexedDB !== "undefined")
    try {
      await db().metadata.put({ key, value });
    } catch {
      /* Metadata caching is best effort. */
    }
}
export async function removeWorkspaceMetadata(prefix: string) {
  if (typeof indexedDB !== "undefined")
    try {
      await db().metadata.where("key").startsWith(prefix).delete();
    } catch {
      /* Cleanup must not block authentication. */
    }
}
/** Clear this principal's cached Studio/plugin metadata, including transport scopes. */
export async function removeWorkspacePluginMetadata(principalScope: string) {
  if (typeof indexedDB === "undefined") return;
  try {
    const metadata = db().metadata;
    const keys = (await metadata.toCollection().primaryKeys()) as string[];
    const clear = keys.filter((key) => {
      if (key.startsWith(`${principalScope}:`)) return true;
      const suffix = [
        ":metadata:/api/objects",
        ":metadata:/api/extensions",
        ":objects",
      ].find((candidate) => key.endsWith(candidate));
      if (!suffix) return false;
      try {
        const transportScope = JSON.parse(key.slice(0, -suffix.length));
        return (
          Array.isArray(transportScope) && transportScope[0] === principalScope
        );
      } catch {
        return false;
      }
    });
    if (clear.length) await metadata.bulkDelete(clear);
  } catch {
    /* Metadata cleanup is best effort and must not block navigation. */
  }
}
/** Persist only an expiring offline workspace identity, never access/refresh tokens. */
export function createLocalSession(
  remote: AuthSession,
  environment: string,
  verifyRemote: () => Promise<void> = () => remote.checkSession(),
): AuthSession {
  let cached: Profile | undefined;
  let generation = 0;
  const assertCurrent = (started: number) => {
    if (started !== generation) throw new StaleLeaseError();
  };
  const snapshot = async (): Promise<LeaseSnapshot> => {
    const started = generation;
    const record = await readProfileRecord(environment);
    assertCurrent(started);
    return { started, record };
  };
  const read = ({ started, record }: LeaseSnapshot) => {
    assertCurrent(started);
    // A missing record or revocation marker takes precedence over memory.
    if (record !== undefined)
      cached = record && "identity" in record ? record : undefined;
    if (!cached || cached.expiresAt <= Date.now())
      throw new Error(
        "Conecta para verificar tu acceso al espacio de trabajo.",
      );
    return cached;
  };
  let renewal: {
    revision: string | null | undefined;
    promise: Promise<void>;
  } | null = null;
  const invalidate = async (expectedRevision?: string | null) => {
    generation++;
    cached = undefined;
    renewal = null;
    await clearSessionCache(environment, expectedRevision);
  };
  const capture = async ({ started, record }: LeaseSnapshot) => {
    const [identity, permissions] = await Promise.all([
      remote.getIdentity(),
      remote.getPermissions(),
    ]);
    assertCurrent(started);
    const profile: Profile = {
      environment,
      identity,
      permissions,
      expiresAt: Date.now() + LEASE_MS,
    };
    if (record !== undefined)
      try {
        const storage = db();
        await storage.transaction("rw", storage.profiles, async () => {
          const current = await storage.profiles.get(environment);
          if (wasRevoked(record, current ?? null)) throw new StaleLeaseError();
          await storage.profiles.put({
            ...profile,
            revocationId: current?.revocationId,
          });
        });
      } catch (error) {
        if (error instanceof StaleLeaseError) throw error;
        /* Online authentication still succeeds without persistence. */
      }
    assertCurrent(started);
    cached = profile;
  };
  const renewLease = async (scope: LeaseSnapshot) => {
    assertCurrent(scope.started);
    const revision = revisionOf(scope.record);
    if (!renewal || renewal.revision !== revision) {
      const pending = (async () => {
        await verifyRemote();
        assertCurrent(scope.started);
        await capture(scope);
      })().finally(() => {
        if (renewal?.promise === pending) renewal = null;
      });
      renewal = { revision, promise: pending };
    }
    await renewal.promise;
    assertCurrent(scope.started);
  };
  const ensureLease = async (scope: LeaseSnapshot) => {
    try {
      read(scope);
    } catch {
      await renewLease(scope);
    }
  };
  const fallback = async <T>(
    action: (scope: LeaseSnapshot) => Promise<T>,
    pick: (profile: Profile) => T,
  ): Promise<T> => {
    const scope = await snapshot();
    try {
      const result = await action(scope);
      assertCurrent(scope.started);
      return result;
    } catch (error) {
      if (scope.started !== generation || error instanceof StaleLeaseError)
        throw error;
      if (!isOfflineError(error)) {
        await invalidate(revisionOf(scope.record));
        throw error;
      }
      const record = await readProfileRecord(environment);
      if (wasRevoked(scope.record, record)) throw new StaleLeaseError();
      return pick(read({ started: scope.started, record }));
    }
  };
  return {
    login: (bookingQuery) => remote.login(bookingQuery),
    getAuthorizeUrl: () => remote.getAuthorizeUrl(),
    getAccessToken: () => remote.getAccessToken(),
    handleCallback: async () => {
      const scope = await snapshot();
      const result = await remote.handleCallback();
      await renewLease(scope);
      return result;
    },
    checkSession: async () => {
      await fallback(
        async (scope) => {
          await remote.checkSession();
          await renewLease(scope);
        },
        () => undefined,
      );
    },
    getIdentity: () =>
      fallback(
        async (scope) => {
          await ensureLease(scope);
          return remote.getIdentity();
        },
        (p) => p.identity,
      ),
    getPermissions: () =>
      fallback(
        async (scope) => {
          await ensureLease(scope);
          return remote.getPermissions();
        },
        (p) => p.permissions,
      ),
    clearSession: async () => {
      await invalidate();
      await remote.clearSession();
    },
    logout: async () => {
      await invalidate();
      return remote.logout();
    },
  };
}
