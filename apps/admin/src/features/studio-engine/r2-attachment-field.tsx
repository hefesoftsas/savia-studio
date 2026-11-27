import { intlLocale, useAppLocale } from "@/i18n/core";
import { useMessages } from "@/i18n/core";
import { recordsMessages } from "@/i18n/locales/records";
import { CreateOfficeAttachment } from "./create-office-attachment";
import { OFFICE_FORMATS, type OfficeFormat } from "@savia/studio-shared/office";
import { OfficeEditButton } from "./office-edit-button";
import { DocumentDeliveryActions } from "./document-delivery-actions";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { R2AttachmentPolicy } from "@savia/studio-shared/metadata";
import { api, downloadCrm } from "./api";
import { FilePicker } from "./file-picker";
import type { AttachmentUploadFailure } from "./attachment-queue";

export type StudioFileAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  field: string;
  version: number;
  created_at: string;
};

export type R2AttachmentFieldProps = {
  field: string;
  failures?: AttachmentUploadFailure[];
  inputId?: string;
  object: string;
  onPendingChange(files: File[]): void;
  onRetryUpload?(file: File): void;
  pending: File[];
  policy: R2AttachmentPolicy;
  refreshVersion?: number;
  recordId?: string;
  disabled?: boolean;
  uploadedFiles?: File[];
  uploadingFiles?: File[];
};

function formatBytes(size: number, locale = "es-CO") {
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toLocaleString(locale, {
    maximumFractionDigits: 1,
  })} MB`;
}

export function R2AttachmentField({
  disabled = false,
  field,
  failures,
  inputId,
  object,
  onPendingChange,
  onRetryUpload,
  pending,
  policy,
  refreshVersion = 0,
  recordId,
  uploadedFiles,
  uploadingFiles = [],
}: R2AttachmentFieldProps) {
  const uiLocale = intlLocale(useAppLocale());

  const t = useMessages(recordsMessages);

  const client = useQueryClient();
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const filesKey = ["r2-attachments", object, recordId, field];
  const query = useQuery({
    enabled: Boolean(recordId),
    queryKey: [...filesKey, refreshVersion],
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await api<{ data?: StudioFileAttachment[] }>(
        `/files/${encodeURIComponent(object)}/${encodeURIComponent(recordId!)}?field=${encodeURIComponent(field)}`,
        "GET",
        undefined,
        { signal },
      );
      return result?.data ?? [];
    },
  });
  const persisted = query.data ?? [];
  const remaining = Math.max(0, policy.maxFiles - persisted.length);

  async function remove(file: StudioFileAttachment) {
    setRemoving(true);
    setError("");
    try {
      await api(`/file/${encodeURIComponent(file.id)}`, "DELETE", {
        version: file.version,
      });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : t("No se pudo eliminar el archivo."),
      );
    } finally {
      setRemoving(false);
      // A lost response can hide a deletion that committed.
      void client.invalidateQueries({ queryKey: filesKey });
    }
  }

  return (
    <div className="grid gap-3">
      {recordId && query.isFetching && (
        <p className="text-sm text-muted-foreground">
          {t("Cargando archivos…")}
        </p>
      )}
      {query.error && !query.isFetching && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive" role="alert">
            {query.error.message || t("No se pudieron cargar los archivos.")}
          </p>
          <Button
            onClick={() => void query.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("Reintentar")}
          </Button>
        </div>
      )}
      {persisted.length > 0 && (
        <ul className="grid gap-2" aria-label={t("Archivos guardados")}>
          {persisted.map((file) => (
            <li
              className="flex min-w-0 items-center gap-3 rounded-md border bg-background px-3 py-2"
              key={file.id}
            >
              <Paperclip
                aria-hidden="true"
                className="shrink-0 text-primary"
                size={16}
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {file.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(file.size, uiLocale)}
              </span>
              <OfficeEditButton file={file} />
              {recordId && (
                <DocumentDeliveryActions file={file} disabled={disabled} />
              )}
              <Button
                aria-label={t("Descargar %{p0}", { p0: file.name })}
                onClick={() =>
                  void downloadCrm(
                    `/api/file/${file.id}/download`,
                    file.name,
                  ).catch((cause: Error) => setError(cause.message))
                }
                size="icon"
                type="button"
                variant="ghost"
              >
                <Download aria-hidden="true" size={16} />
              </Button>
              <Button
                aria-label={t("Eliminar %{p0}", { p0: file.name })}
                disabled={disabled || removing}
                onClick={() => void remove(file)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" size={16} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!recordId && (
        <p className="text-sm text-muted-foreground">
          {t(
            "El archivo se cargará ahora y se asociará al guardar el registro.",
          )}
        </p>
      )}
      <div>
        <CreateOfficeAttachment
          disabled={
            disabled || uploadingFiles.length > 0 || pending.length >= remaining
          }
          formats={(Object.keys(OFFICE_FORMATS) as OfficeFormat[]).filter(
            (format) =>
              !policy.accept.length ||
              policy.accept.some(
                (mime) =>
                  mime === OFFICE_FORMATS[format].mime ||
                  (mime.endsWith("/*") &&
                    OFFICE_FORMATS[format].mime.startsWith(mime.slice(0, -1))),
              ),
          )}
          maxSize={policy.maxSize}
          onCreate={async (file) => {
            onPendingChange([...pending, file]);
          }}
        />
      </div>
      <FilePicker
        accept={policy.accept}
        disabled={disabled || uploadingFiles.length > 0 || remaining === 0}
        failures={failures}
        files={pending}
        inputId={inputId}
        maxFiles={Math.min(remaining, policy.maxFiles)}
        maxSize={policy.maxSize}
        onFilesChange={onPendingChange}
        onRetry={onRetryUpload}
        uploadedFiles={uploadedFiles}
        uploadingFiles={uploadingFiles}
      />
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
