import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Save } from "lucide-react";
import {
  OfficeApi,
  OfficeSaveUnconfirmedError,
  type OfficeMetadata,
  type OfficeRevision,
} from "./office-api";
import { loadOfficeEngine, type OfficeEngine } from "./office-engine";
type OfficeSaveSnapshot = {
  bytes: Uint8Array;
  generation: number;
  version: number;
};

function download(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(
    new Blob([bytes.slice().buffer], { type: mime }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function OfficePage({
  search = window.location.search,
}: {
  search?: string;
}) {
  const returnTo =
    new URLSearchParams(search).get("base") === "/v1/office-documents"
      ? "/#/office-suite"
      : "/";
  const canvas = useRef<HTMLCanvasElement>(null),
    engine = useRef<OfficeEngine | null>(null);
  const api = useRef<OfficeApi | null>(null),
    busy = useRef(false),
    changed = useRef(false),
    saveAction = useRef(() => {});
  const changes = useRef(0);
  const pendingSave = useRef<OfficeSaveSnapshot | null>(null);
  const readOnly = useRef(false);
  const originalBytes = useRef<Uint8Array | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const [meta, setMeta] = useState<OfficeMetadata | null>(null);
  const [revisions, setRevisions] = useState<OfficeRevision[]>([]);
  const [historyStatus, setHistoryStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [status, setStatus] = useState("Abriendo documento…"),
    [error, setError] = useState("");
  const [ready, setReady] = useState(false),
    [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false);
  function markDirty() {
    if (readOnly.current) return;
    changes.current++;
    changed.current = true;
    setDirty(true);
  }
  const refreshHistory = useCallback(async (client: OfficeApi) => {
    historyRequest.current?.abort();
    const request = new AbortController();
    historyRequest.current = request;
    setHistoryStatus("loading");
    const isCurrent = () =>
      api.current === client &&
      historyRequest.current === request &&
      !request.signal.aborted;
    try {
      const history = await client.revisions(request.signal);
      if (!isCurrent()) return;
      setRevisions(history);
      setHistoryStatus("ready");
    } catch (error) {
      if (!isCurrent()) return;
      if (
        error instanceof Error &&
        "status" in error &&
        (error.status === 401 || error.status === 403)
      )
        setRevisions([]);
      setHistoryStatus("error");
    } finally {
      if (historyRequest.current === request) historyRequest.current = null;
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.current = null;
    pendingSave.current = null;
    busy.current = false;
    setReady(false);
    setSaving(false);
    setRevisions([]);
    setHistoryStatus("idle");
    readOnly.current = false;
    originalBytes.current = null;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (changed.current || busy.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    const keydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveAction.current();
      }
    };
    window.addEventListener("keydown", keydown, true);
    void (async () => {
      try {
        const query = new URLSearchParams(search),
          client = new OfficeApi(
            query.get("base") ?? "",
            query.get("file") ?? "",
          );
        api.current = client;
        const info = await client.metadata();
        if (cancelled) return;
        setMeta(info);
        readOnly.current = info.readOnly;
        document.title = info.name + " · Savia";
        if (info.size > info.maxSize)
          throw new Error(
            "El archivo supera el tamaño admitido por el editor.",
          );
        setStatus("Cargando editor… La primera apertura puede tardar.");
        const bytes = await client.download(info.version);
        if (cancelled) return;
        originalBytes.current = bytes.slice();
        const runtime = await loadOfficeEngine(canvas.current!, {
          onDirty: markDirty,
          onError: (e) => {
            if (!cancelled) {
              setError(e.message);
              setReady(false);
            }
          },
          onSave: () => {
            if (!readOnly.current) saveAction.current();
          },
        });
        if (cancelled) {
          runtime.dispose();
          return;
        }
        engine.current = runtime;
        await runtime.open(bytes, info.name, { readOnly: info.readOnly });
        if (cancelled) return;
        setReady(true);
        setStatus(info.readOnly ? "Modo de solo lectura" : "Guardado en Savia");
        void refreshHistory(client);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "No se pudo abrir el documento.",
          );
          setStatus("No se pudo abrir el documento");
        }
      }
    })();
    return () => {
      cancelled = true;
      historyRequest.current?.abort();
      engine.current?.dispose();
      engine.current = null;
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [search, refreshHistory]);
  async function save() {
    const client = api.current;
    const editor = engine.current;
    if (
      !ready ||
      !meta ||
      meta.readOnly ||
      !client ||
      !editor ||
      busy.current ||
      !changed.current
    )
      return;
    busy.current = true;
    setSaving(true);
    setError("");
    let attempt =
      pendingSave.current?.version === meta.version
        ? pendingSave.current
        : null;
    const retrying = attempt !== null;
    try {
      attempt ??= {
        bytes: await editor.save(),
        generation: changes.current,
        version: meta.version,
      };
      if (api.current !== client) return;
      const result = await client.save(meta, attempt.bytes, retrying);
      if (api.current !== client) return;
      pendingSave.current = null;
      setMeta({ ...meta, version: result.version, size: attempt.bytes.length });
      changed.current = changes.current !== attempt.generation;
      setDirty(changed.current);
      setStatus("Guardado en Savia");
      void refreshHistory(client);
    } catch (e) {
      if (api.current !== client) return;
      pendingSave.current =
        e instanceof OfficeSaveUnconfirmedError ? attempt : null;
      setError(
        e instanceof Error
          ? e.message
          : "No se pudo guardar. Descarga una copia para conservar tus cambios.",
      );
    } finally {
      if (api.current === client) {
        busy.current = false;
        setSaving(false);
      }
    }
  }
  saveAction.current = () => void save();
  async function recovery() {
    if (!meta || (!meta.readOnly && !engine.current) || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const bytes = meta.readOnly
        ? originalBytes.current
        : await engine.current!.save();
      if (!bytes)
        throw new Error("No se pudo descargar el documento original.");
      download(bytes, meta.name, meta.mime);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function versionDownload(version: number) {
    if (!meta) return;
    try {
      download(
        await api.current!.download(version),
        meta.name.replace(/(\.[^.]+)$/, "-v" + version + "$1"),
        meta.mime,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="office-page">
      <header className="office-header">
        <a
          className="office-back"
          href={returnTo}
          onClick={(e) => {
            if (
              (changed.current || busy.current) &&
              !window.confirm("Hay cambios sin guardar. ¿Salir del documento?")
            )
              e.preventDefault();
          }}
        >
          ← Savia
        </a>
        <div className="office-title">
          <span className="office-suite-label">Suite de ofimática</span>
          <h1>{meta?.name ?? "Editar documento"}</h1>
          <p role="status">
            {saving ? "Guardando…" : dirty ? "Cambios sin guardar" : status}
            {meta && (
              <span className="office-version">Versión {meta.version}</span>
            )}
          </p>
        </div>
        <div className="office-actions">
          <button
            aria-label="Descargar copia"
            onClick={() => void recovery()}
            disabled={!ready || saving}
          >
            <Download className="office-action-icon" aria-hidden="true" />
            <span className="office-action-label">Descargar copia</span>
          </button>
          {!meta?.readOnly ? (
            <button
              className="office-save"
              aria-label="Guardar"
              onClick={() => void save()}
              disabled={!ready || !dirty || saving}
            >
              <Save className="office-action-icon" aria-hidden="true" />
              <span className="office-action-label">Guardar</span>
            </button>
          ) : null}
        </div>
      </header>
      {error && (
        <div className="office-error" role="alert">
          <p>{error}</p>
          {ready ? (
            <p>
              Tus cambios siguen en esta ventana. Descarga una copia antes de
              volver a abrir el archivo.
            </p>
          ) : (
            <a href={returnTo}>Volver a Savia</a>
          )}
        </div>
      )}
      <section className="office-workspace" aria-label="Documento">
        {!ready && !error && (
          <div className="office-loading" role="status">
            <div className="office-loading-mark" aria-hidden="true">
              S
            </div>
            <strong>Preparando tu espacio de trabajo</strong>
            <p>{status}</p>
            <span>Motor de edición: ZetaOffice · WebAssembly</span>
          </div>
        )}
        <canvas
          ref={canvas}
          id="qtcanvas"
          contentEditable={!meta?.readOnly}
          suppressContentEditableWarning
          aria-readonly={meta?.readOnly || undefined}
          tabIndex={0}
          aria-label="Contenido del documento"
          style={{ visibility: ready ? "visible" : "hidden" }}
          inert={saving}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => e.preventDefault()}
        />
      </section>
      <footer className="office-footer">
        <div className="office-footer-info">
          <span>
            {meta?.readOnly
              ? "Documento abierto en modo de solo lectura."
              : "Los cambios se guardan al pulsar Guardar."}
          </span>
          <span className="office-attribution">
            Motor de edición: ZetaOffice
          </span>
        </div>
        <details>
          <summary>Historial de versiones</summary>
          <ul>
            {revisions.map((r) => (
              <li key={r.version}>
                <span>
                  Versión {r.version} ·{" "}
                  {new Date(r.created_at).toLocaleString("es-CO")}
                </span>
                <button
                  aria-label={`Descargar versión ${r.version}`}
                  onClick={() => void versionDownload(r.version)}
                >
                  <Download className="office-action-icon" aria-hidden="true" />
                  <span className="office-action-label">
                    Descargar versión {r.version}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {historyStatus === "loading" && (
            <p role="status">Cargando historial…</p>
          )}
          {historyStatus === "error" && (
            <>
              <p role="status">No se pudo actualizar el historial.</p>
              <button
                type="button"
                onClick={() => {
                  if (api.current) void refreshHistory(api.current);
                }}
              >
                Reintentar historial
              </button>
            </>
          )}
          {historyStatus === "ready" && !revisions.length && (
            <p>Todavía no hay versiones en el historial.</p>
          )}
        </details>
      </footer>
    </main>
  );
}
