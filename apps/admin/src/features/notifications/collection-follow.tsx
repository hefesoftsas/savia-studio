import { useState } from "react";
import { useTranslate } from "ra-core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useSessionGeneration } from "@/auth/session-scope";
import { notificationClient, type NotificationClient } from "./client";
import { notificationReadKey } from "./queries";

export function CollectionFollow({
  collection,
  client = notificationClient,
}: {
  collection: string;
  client?: NotificationClient;
}) {
  const translate = useTranslate();
  const t = (key: string) => translate(`savia.notificationInbox.${key}`);
  const queryClient = useQueryClient();
  const sessionGeneration = useSessionGeneration();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const follows = useQuery({
    queryKey: notificationReadKey(sessionGeneration, "follows"),
    queryFn: () => client.follows(),
  });
  const following = follows.data?.includes(collection) ?? false;

  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      if (following) await client.unfollow(collection);
      else await client.follow(collection);
      await queryClient.invalidateQueries({
        queryKey: notificationReadKey(sessionGeneration, "follows"),
      });
    } catch {
      setError(t("actionError"));
    } finally {
      setBusy(false);
    }
  };

  if (follows.data === undefined) {
    if (!follows.isError)
      return (
        <span role="status" className="text-sm text-muted-foreground">
          {t("followLoading")}
        </span>
      );
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <span role="status" className="text-sm text-muted-foreground">
          {t("followLoadError")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="max-sm:h-11"
          disabled={follows.isFetching}
          onClick={() => void follows.refetch()}
        >
          {t("retry")}
        </Button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="max-sm:h-11"
        disabled={busy}
        aria-pressed={following}
        onClick={() => void toggle()}
      >
        {t(following ? "unfollow" : "follow")}
      </Button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
