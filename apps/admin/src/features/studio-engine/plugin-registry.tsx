import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/core";
import { api } from "./api";

const messages = {
  title: ["Catálogo compartido", "Shared catalog", "Catálogo compartilhado"],
  description: [
    "Añade una versión a este espacio y luego instálala desde Mis plugins.",
    "Add a version to this workspace, then install it from My plugins.",
    "Adicione uma versão a este espaço e instale-a em Meus plugins.",
  ],
  empty: [
    "No hay versiones publicadas.",
    "No published versions.",
    "Não há versões publicadas.",
  ],
  unavailable: [
    "El catálogo compartido no está disponible. Tus plugins instalados siguen disponibles.",
    "The shared catalog is unavailable. Your installed plugins remain available.",
    "O catálogo compartilhado está indisponível. Seus plugins instalados continuam disponíveis.",
  ],
  retry: ["Reintentar", "Retry", "Tentar novamente"],
  add: ["Añadir al espacio", "Add to workspace", "Adicionar ao espaço"],
  adding: ["Añadiendo…", "Adding…", "Adicionando…"],
  install: ["Instalar versión", "Install version", "Instalar versão"],
  installed: ["Versión instalada", "Version installed", "Versão instalada"],
  installFailed: [
    "No se pudo instalar esta versión.",
    "Could not install this version.",
    "Não foi possível instalar esta versão.",
  ],
  added: ["Añadido al espacio", "Added to workspace", "Adicionado ao espaço"],
  failed: [
    "No se pudo añadir esta versión. Reintenta la importación.",
    "Could not add this version. Retry the import.",
    "Não foi possível adicionar esta versão. Tente importar novamente.",
  ],
  refreshFailed: [
    "El cambio se guardó. No pudimos actualizar la lista de plugins.",
    "The change was saved. We could not refresh the plugin list.",
    "A alteração foi salva. Não foi possível atualizar a lista de plugins.",
  ],
  refreshWorkspace: [
    "Actualizar lista de plugins",
    "Refresh plugin list",
    "Atualizar lista de plugins",
  ],
  more: ["Cargar más versiones", "Load more versions", "Carregar mais versões"],
  loading: ["Cargando catálogo…", "Loading catalog…", "Carregando catálogo…"],
} as const;
type Release = {
  id: string;
  version: string;
  label: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
};
type Catalog = { configured: boolean; data: Release[]; cursor: string | null };
type WorkspaceVersion = {
  manifest: { id: string };
  version: string;
  sha256: string;
  installed: { version: string; enabled: boolean } | null;
};
const noWorkspaceVersions: readonly WorkspaceVersion[] = [];

function pinnedReleaseKey(id: string, version: string, sha256: string) {
  return `${id}@${version}#${sha256}`;
}

/** Server-authorized catalog; credentials never enter browser state. */
export function PluginRegistry({
  onImported,
  workspaceVersions = noWorkspaceVersions,
  getLatestWorkspaceVersions,
  mutationPending = false,
  runMutation = (operation) => operation(),
}: {
  onImported: () => void | Promise<unknown>;
  workspaceVersions?: readonly WorkspaceVersion[];
  getLatestWorkspaceVersions?: () => readonly WorkspaceVersion[];
  mutationPending?: boolean;
  runMutation?: (operation: () => Promise<void>) => Promise<void>;
}) {
  const t = useMessages(messages);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const operationPending = mutationPending || busy !== null;
  const [confirmed, setConfirmed] = useState<{
    inventory: readonly WorkspaceVersion[];
    added: ReadonlySet<string>;
    active: ReadonlyMap<string, string>;
  }>();
  // Use confirmed writes until the parent supplies a refreshed inventory.
  const changes =
    confirmed?.inventory === workspaceVersions ? confirmed : undefined;
  const local = new Map(
    workspaceVersions.map((item) => [
      pinnedReleaseKey(item.manifest.id, item.version, item.sha256),
      item,
    ]),
  );
  const alive = useRef(true);
  const generation = useRef(0);

  async function load(cursor?: string) {
    const current = ++generation.current;
    setLoading(true);
    setUnavailable(false);
    try {
      const result = await api<Catalog>(
        `/plugin-store/registry${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!alive.current || current !== generation.current) return;
      if (
        !result ||
        typeof result.configured !== "boolean" ||
        !Array.isArray(result.data)
      )
        throw new Error();
      setCatalog((previous) => ({
        ...result,
        data: cursor
          ? [...(previous?.data ?? []), ...result.data].filter(
              (item, index, all) =>
                all.findIndex(
                  (other) =>
                    other.id === item.id && other.version === item.version,
                ) === index,
            )
          : result.data,
      }));
    } catch (reason) {
      if (!alive.current || current !== generation.current) return;
      if (
        (reason as { status?: number })?.status === 403 ||
        (reason as { status?: number })?.status === 404
      )
        setCatalog({ configured: false, data: [], cursor: null });
      else setUnavailable(true);
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);

  async function refreshWorkspace() {
    setRefreshFailed(false);
    try {
      await onImported();
    } catch {
      if (alive.current) setRefreshFailed(true);
    }
  }

  function rememberRelease(release: Release, action: "add" | "install") {
    const key = pinnedReleaseKey(release.id, release.version, release.sha256);
    // An earlier read may have completed while the mutation was pending.
    const inventory = getLatestWorkspaceVersions?.() ?? workspaceVersions;
    setConfirmed((previous) => {
      const current =
        previous?.inventory === inventory
          ? previous
          : {
              inventory,
              added: new Set<string>(),
              active: new Map<string, string>(),
            };
      return action === "add"
        ? { ...current, added: new Set(current.added).add(key) }
        : { ...current, active: new Map(current.active).set(release.id, key) };
    });
  }

  async function add(release: Release) {
    const key = pinnedReleaseKey(release.id, release.version, release.sha256);
    setBusy(key);
    setError("");
    try {
      await api("/plugin-store/registry/import", "POST", {
        id: release.id,
        version: release.version,
        sha256: release.sha256,
      });
      if (!alive.current) return;
      rememberRelease(release, "add");
      await refreshWorkspace();
    } catch (reason) {
      if (alive.current)
        setError(
          reason instanceof Error && "status" in reason && reason.status === 409
            ? reason.message
            : t("failed"),
        );
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  async function install(release: Release) {
    const key = pinnedReleaseKey(release.id, release.version, release.sha256);
    setBusy(key);
    setError("");
    try {
      await api(
        `/extensions/${encodeURIComponent(release.id)}/install`,
        "POST",
        { version: release.version, sha256: release.sha256 },
      );
      if (!alive.current) return;
      rememberRelease(release, "install");
      await refreshWorkspace();
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : t("installFailed"));
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  if (catalog?.configured === false || (!catalog && !unavailable)) return null;
  return (
    <section
      aria-label={t("title")}
      className="savia-surface-card overflow-hidden"
    >
      <header className="space-y-1 border-b px-6 py-4">
        <h3 className="text-base font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>
      {unavailable && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 px-6 py-4"
        >
          <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || busy !== null}
            onClick={() => void load(catalog?.cursor ?? undefined)}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="px-6 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {refreshFailed && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4"
        >
          <p className="text-sm text-muted-foreground">{t("refreshFailed")}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={operationPending}
            onClick={() => void refreshWorkspace()}
          >
            {t("refreshWorkspace")}
          </Button>
        </div>
      )}
      {catalog?.configured && (
        <>
          {catalog.data.length === 0 && !unavailable && (
            <p className="px-6 py-5 text-sm text-muted-foreground">
              {t("empty")}
            </p>
          )}
          <ul className="divide-y">
            {catalog.data.map((release) => {
              const key = pinnedReleaseKey(
                release.id,
                release.version,
                release.sha256,
              );
              const workspaceVersion = local.get(key);
              const added = Boolean(
                workspaceVersion || changes?.added.has(key),
              );
              const justInstalled = changes?.active.get(release.id);
              const installed =
                justInstalled !== undefined
                  ? justInstalled === key
                  : workspaceVersion?.installed?.enabled === true &&
                    workspaceVersion.installed.version === release.version;
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center gap-3 px-6 py-3"
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="break-words text-sm font-medium">
                      {release.label}{" "}
                      <span className="font-normal text-muted-foreground">
                        {release.version}
                      </span>
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {release.id}
                    </p>
                  </div>
                  {added ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        role="status"
                        className="text-xs text-muted-foreground"
                      >
                        {installed ? t("installed") : t("added")}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={operationPending || installed}
                        aria-label={`${t("install")} ${release.label} ${release.version}`}
                        onClick={() => void runMutation(() => install(release))}
                      >
                        {t("install")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={operationPending}
                      aria-label={`${t("add")} ${release.label} ${release.version}`}
                      onClick={() => void runMutation(() => add(release))}
                    >
                      <Download aria-hidden="true" className="size-4" />
                      {busy === key ? t("adding") : t("add")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {catalog.cursor && !unavailable && (
            <div className="border-t px-6 py-3">
              <Button
                size="sm"
                variant="ghost"
                disabled={loading || busy !== null}
                onClick={() => void load(catalog.cursor!)}
              >
                {loading ? t("loading") : t("more")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
