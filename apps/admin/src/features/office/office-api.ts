import { withRequestTimeout } from "@/api/request-timeout";

const officeRequestTimeoutMs = 45_000;
const confirmationTimeoutMs = 5_000;

class OfficeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class OfficeSaveUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super(
      "No se pudo confirmar el guardado. Vuelve a guardar o descarga una copia de tus cambios.",
      { cause },
    );
  }
}

export type OfficeMetadata = {
  id: string;
  name: string;
  mime: string;
  size: number;
  version: number;
  field: string | null;
  object: string | null;
  recordId: string | null;
  maxSize: number;
  readOnly: boolean;
};
export type OfficeRevision = {
  version: number;
  size: number;
  created_at: string;
  created_by: string | null;
};
export function officeEditorUrl(base: string | undefined, file: string) {
  if (
    !base ||
    !/^\/v1\/(?:(?:studio|dynamic-crm)\/[0-9]+|office-documents)$/.test(base) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(file)
  )
    return null;
  return "/office/?" + new URLSearchParams({ base, file });
}
export class OfficeApi {
  constructor(
    private base: string,
    private file: string,
  ) {
    if (!officeEditorUrl(base, file))
      throw new Error("El enlace del documento no es válido.");
  }
  private request<T>(
    suffix: string,
    read: (response: Response) => Promise<T>,
    init?: RequestInit,
    timeoutMs = officeRequestTimeoutMs,
  ): Promise<T> {
    return withRequestTimeout(
      async (signal) => {
        const response = await fetch(
          this.base + "/api/file/" + encodeURIComponent(this.file) + suffix,
          { ...init, credentials: "same-origin", cache: "no-store", signal },
        );
        if (!response.ok) {
          const permissionMessage =
            response.status === 401
              ? "Tu sesión venció. Descarga tus cambios e inicia sesión en Savia."
              : response.status === 403
                ? "No tienes permiso para editar este archivo."
                : undefined;
          if (permissionMessage) {
            void response.body?.cancel().catch(() => undefined);
            throw new OfficeRequestError(response.status, permissionMessage);
          }
          const body = await response.json().catch(() => null);
          const message =
            typeof body?.error === "string"
              ? body.error
              : (body?.error?.message ?? "No se pudo completar la operación.");
          throw new OfficeRequestError(response.status, message);
        }
        return read(response);
      },
      timeoutMs,
      init?.signal,
    );
  }
  async metadata(): Promise<OfficeMetadata> {
    return this.request(
      "/office",
      async (response) => (await response.json()).data,
    );
  }
  async revisions(signal?: AbortSignal): Promise<OfficeRevision[]> {
    return this.request(
      "/revisions",
      async (response) => {
        const data = (await response.json())?.data;
        if (
          !Array.isArray(data) ||
          data.some(
            (revision) =>
              !Number.isSafeInteger(revision?.version) ||
              typeof revision?.created_at !== "string",
          )
        )
          throw new Error("Invalid Office revision history");
        return data;
      },
      { signal },
    );
  }
  download(version: number, timeoutMs = officeRequestTimeoutMs) {
    return this.request(
      "/revisions/" + version + "/download",
      async (response) => new Uint8Array(await response.arrayBuffer()),
      undefined,
      timeoutMs,
    );
  }
  private async checkCommittedRevision(
    version: number,
    expected: Uint8Array,
  ): Promise<"saved" | "conflict" | "missing" | "unavailable"> {
    try {
      const actual = await this.download(version, confirmationTimeoutMs);
      return actual.length === expected.length &&
        actual.every((byte, index) => byte === expected[index])
        ? "saved"
        : "conflict";
    } catch (error) {
      return error instanceof OfficeRequestError && error.status === 404
        ? "missing"
        : "unavailable";
    }
  }
  async save(
    meta: OfficeMetadata,
    bytes: Uint8Array,
    retrying = false,
  ): Promise<{ version: number }> {
    if (meta.readOnly) throw new Error("Este archivo es de solo lectura.");
    if (bytes.byteLength > meta.maxSize)
      throw new Error(
        "El archivo supera el tamaño permitido para este campo. Descarga una copia de tus cambios.",
      );
    const version = meta.version + 1;
    if (retrying) {
      const confirmed = await this.checkCommittedRevision(version, bytes);
      if (confirmed === "saved") return { version };
      if (confirmed === "conflict")
        throw new OfficeRequestError(
          409,
          "Hay una versión más reciente. Descarga tus cambios antes de volver a abrir el archivo.",
        );
    }
    const form = new FormData();
    form.set("version", String(meta.version));
    form.set(
      "file",
      new File([bytes.slice().buffer], meta.name, { type: meta.mime }),
    );
    try {
      const savedVersion = await this.request(
        "/revisions",
        async (response) => (await response.json())?.data?.version,
        { method: "POST", body: form },
      );
      if (savedVersion !== version)
        throw new Error("Invalid Office save confirmation");
      return { version };
    } catch (error) {
      if (
        error instanceof OfficeRequestError &&
        error.status < 500 &&
        error.status !== 408
      ) {
        if (retrying && error.status === 409) {
          const confirmed = await this.checkCommittedRevision(version, bytes);
          if (confirmed === "saved") return { version };
          if (confirmed === "unavailable")
            throw new OfficeSaveUnconfirmedError(error);
        }
        throw error;
      }
      throw new OfficeSaveUnconfirmedError(error);
    }
  }
}
