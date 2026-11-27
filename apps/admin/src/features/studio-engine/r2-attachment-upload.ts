import type { AttachmentUploadStatus, PendingAttachment } from "./dynamic-form";
import { createStudioRequest } from "./api";

export type TemporaryR2Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  field: string;
  version: number;
  expiresAt: string;
};

export class TemporaryAttachmentUnavailableError extends Error {
  constructor(
    readonly attachmentId: string,
    message: string,
  ) {
    super(message);
    this.name = "TemporaryAttachmentUnavailableError";
  }
}

export function expiredAttachmentIds(attachments: TemporaryR2Attachment[]) {
  const now = Date.now();
  return attachments
    .filter(({ expiresAt }) => Date.parse(expiresAt) <= now)
    .map(({ id }) => id);
}

export async function uploadTemporaryR2Attachment(
  object: string,
  field: string,
  file: File,
  target?: { recordId: string } | { createRequestKey: string },
  request = createStudioRequest(),
): Promise<TemporaryR2Attachment> {
  const body = new FormData();
  body.set("field", field);
  body.set("file", file);
  if (target) {
    if ("recordId" in target) body.set("recordId", target.recordId);
    else body.set("createRequestKey", target.createRequestKey);
  }
  const result = await request<{
    data?: TemporaryR2Attachment;
    error?: string;
  }>(`/file-drafts/${encodeURIComponent(object)}`, "POST", body);
  if (!result?.data?.id)
    throw new Error(result?.error ?? "No se pudo subir el archivo.");
  return result.data;
}

export async function attachTemporaryR2Attachments(
  recordId: string,
  attachments: TemporaryR2Attachment[],
  request = createStudioRequest(),
) {
  for (const attachment of attachments) {
    const result = await request<{ data?: { id: string }; error?: string }>(
      `/file-drafts/${encodeURIComponent(attachment.id)}/attach`,
      "POST",
      { recordId, version: attachment.version },
    ).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ATTACHMENT_DRAFT_UNAVAILABLE"
      )
        throw new TemporaryAttachmentUnavailableError(
          attachment.id,
          error.message,
        );
      throw error;
    });
    if (result?.data?.id !== attachment.id)
      throw new Error(
        result?.error ?? "No se pudo asociar el archivo al registro.",
      );
  }
}

export async function deleteTemporaryR2Attachments(
  attachments: TemporaryR2Attachment[],
  request = createStudioRequest(),
) {
  await Promise.all(
    attachments.map((attachment) =>
      request(`/file/${encodeURIComponent(attachment.id)}`, "DELETE", {
        version: attachment.version,
        draftOnly: true,
      }),
    ),
  );
}

export function discardTemporaryAttachmentsInBackground(
  discard:
    ((attachments: TemporaryR2Attachment[]) => Promise<void>) | undefined,
  attachments: TemporaryR2Attachment[],
) {
  if (!discard || !attachments.length) return;
  // The backend also expires drafts during later attachment requests.
  void (async () => discard(attachments))().catch(() => undefined);
}

export async function uploadR2Attachments(
  object: string,
  recordId: string,
  attachments: PendingAttachment[],
  onStatus: (status: AttachmentUploadStatus) => void = () => {},
) {
  const request = createStudioRequest();
  for (const attachment of attachments) {
    for (const file of attachment.files) {
      onStatus({ field: attachment.field, file, status: "uploading" });
      const body = new FormData();
      body.set("field", attachment.field);
      body.set("file", file);
      const result = await request<{ data?: { id: string }; error?: string }>(
        `/files/${encodeURIComponent(object)}/${encodeURIComponent(recordId)}`,
        "POST",
        body,
      );
      if (!result?.data?.id)
        throw new Error(result?.error ?? "No se pudo subir el archivo a R2.");
      onStatus({ field: attachment.field, file, status: "uploaded" });
    }
  }
}
