import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/core";
import { backgroundRefreshMessages } from "@/i18n/locales/background-refresh";

export function TenantScopeBoundary({
  status,
  retry,
  organizationPickerHref,
  children,
}: {
  status?: "platform" | "loading" | "resolved" | "error" | "unavailable";
  retry?: () => void;
  organizationPickerHref?: string;
  children: ReactNode;
}) {
  const t = useMessages(backgroundRefreshMessages);
  if (!status || status === "platform" || status === "resolved")
    return children;
  if (status === "loading")
    return (
      <p role="status" className="p-6">
        {t("Loading workspace")}
      </p>
    );
  return (
    <section role="alert" className="grid justify-items-start gap-3 p-6">
      <p>{t("Workspace could not be resolved")}</p>
      {(retry || organizationPickerHref) && (
        <div className="flex flex-wrap gap-2">
          {retry && (
            <Button type="button" variant="outline" onClick={retry}>
              {t("Retry")}
            </Button>
          )}
          {organizationPickerHref && (
            <Button asChild variant="ghost">
              <a href={organizationPickerHref}>
                {t("Choose another organization")}
              </a>
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
