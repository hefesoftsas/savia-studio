import { createContext, useContext, type ReactNode } from "react";
import type { TemporaryR2Attachment } from "./r2-attachment-upload";

export type AttachmentUploadFailure = {
  field: string;
  file: File;
  message: string;
};

type AttachmentQueue = {
  files: Record<string, File[]>;
  setFiles(field: string, files: File[]): void;
  uploading: Record<string, File[]>;
  uploaded: Record<string, File[]>;
  failures: AttachmentUploadFailure[];
  retry(field: string, file: File): void;
  version: number;
  saving: boolean;
};

const AttachmentQueueContext = createContext<AttachmentQueue | null>(null);

export function updateUploadingFiles(
  files: AttachmentQueue["uploading"],
  field: string,
  file: File,
  uploading: boolean,
): AttachmentQueue["uploading"] {
  const active = files[field] ?? [];
  return {
    ...files,
    [field]: uploading
      ? [...active, file]
      : active.filter((item) => item !== file),
  };
}

export function releaseUnavailableAttachmentUploads(
  uploads: { field: string; file: File; attachment: TemporaryR2Attachment }[],
  ids: string[],
  handled: Set<File>,
) {
  if (!ids.length) return uploads;
  const unavailable = new Set(ids);
  const retained = uploads.filter(({ file, attachment }) => {
    if (!unavailable.has(attachment.id)) return true;
    handled.delete(file);
    return false;
  });
  return retained.length === uploads.length ? uploads : retained;
}

export function AttachmentQueueProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: AttachmentQueue;
}) {
  return (
    <AttachmentQueueContext.Provider value={value}>
      {children}
    </AttachmentQueueContext.Provider>
  );
}

export function useAttachmentQueue(field: string, fallback: File[]) {
  const queue = useContext(AttachmentQueueContext);
  return {
    files: queue?.files[field] ?? fallback,
    setFiles: (files: File[]) => queue?.setFiles(field, files),
    uploadingFiles: queue?.uploading[field] ?? [],
    uploadedFiles: queue?.uploaded?.[field] ?? [],
    failures:
      queue?.failures.filter((failure) => failure.field === field) ?? [],
    retry: (file: File) => queue?.retry(field, file),
    version: queue?.version ?? 0,
    saving: queue?.saving ?? false,
  };
}
