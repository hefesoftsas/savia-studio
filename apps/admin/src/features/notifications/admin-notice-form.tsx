import { useRef, useState } from "react";
import { useTranslate } from "ra-core";
import { getSessionGeneration } from "@/auth/session-scope";
import { Button } from "@/components/ui/button";
import { notificationClient, type NotificationClient } from "./client";

export function AdminNoticeForm({
  scope,
  canAdminister,
  client = notificationClient,
  onSent,
}: {
  scope: string;
  canAdminister: boolean;
  client?: NotificationClient;
  onSent?: (eventId: string) => void;
}) {
  const translate = useTranslate();
  const t = (key: string) => translate(`savia.notificationInbox.${key}`);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [principals, setPrincipals] = useState("");
  const [allMembers, setAllMembers] = useState(false);
  const [requireAcknowledgement, setRequireAcknowledgement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pendingSend = useRef<{ fingerprint: string; key: string } | null>(null);

  if (!canAdminister) return null;

  const send = async () => {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const input = {
        scope,
        title: title.trim(),
        body,
        requireAcknowledgement,
        audience: allMembers
          ? { kind: "workspace-members" as const }
          : {
              kind: "explicit" as const,
              principals: principals
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
            },
      };
      const fingerprint = JSON.stringify([getSessionGeneration(), input]);
      if (pendingSend.current?.fingerprint !== fingerprint)
        pendingSend.current = {
          fingerprint,
          key: `manual-${crypto.randomUUID()}`,
        };
      const attempt = pendingSend.current;
      const result = await client.sendAdminNotice({
        ...input,
        key: attempt.key,
      });
      if (pendingSend.current === attempt) pendingSend.current = null;
      setNotice(
        result.duplicate
          ? t("duplicateAccepted")
          : `${t("accepted")}: ${result.eventId}`,
      );
      onSent?.(result.eventId);
    } catch (exception) {
      setError(
        String(exception).includes("429")
          ? t("quotaExceeded")
          : t("actionError"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-md border p-3"
      aria-label={t("adminTitle")}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <h2 className="text-sm font-semibold">{t("adminTitle")}</h2>
      <label className="flex flex-col gap-1 text-sm">
        {t("adminSubject")}
        <input
          className="min-h-11 rounded border px-2 py-2"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("adminBody")}
        <textarea
          className="min-h-24 rounded border px-2 py-2"
          value={body}
          maxLength={4000}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          className="size-5"
          type="checkbox"
          checked={allMembers}
          onChange={(event) => setAllMembers(event.target.checked)}
        />
        {t("adminAllMembers")}
      </label>
      {!allMembers && (
        <label className="flex flex-col gap-1 text-sm">
          {t("adminRecipients")}
          <input
            className="min-h-11 rounded border px-2 py-2"
            value={principals}
            placeholder="alice, bob"
            onChange={(event) => setPrincipals(event.target.value)}
            required
          />
        </label>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          className="size-5"
          type="checkbox"
          checked={requireAcknowledgement}
          onChange={(event) => setRequireAcknowledgement(event.target.checked)}
        />
        {t("adminRequireAcknowledgement")}
      </label>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <Button
        type="submit"
        size="sm"
        className="max-sm:h-11"
        disabled={busy || !title.trim()}
      >
        {t("adminSend")}
      </Button>
    </form>
  );
}
