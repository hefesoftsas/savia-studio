import { useLocation } from "react-router-dom";
import { getAdminAuthorizeUrl } from "@/components/admin/loading-recovery";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/core";
import { loadingMessages } from "@/i18n/locales/loading";
import { cn } from "@/lib/utils";

export function BookingSignInRecovery({ className }: { className?: string }) {
  const { search } = useLocation();
  const t = useMessages(loadingMessages);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <p role="alert" className="text-sm text-destructive">
        {t("sessionExpired")}
      </p>
      <Button asChild className="min-h-11 whitespace-normal">
        <a href={getAdminAuthorizeUrl(search)}>{t("signInAgain")}</a>
      </Button>
    </div>
  );
}
