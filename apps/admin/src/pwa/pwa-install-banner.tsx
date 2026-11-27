import { useCallback, useState } from "react";
import { Download, X } from "lucide-react";
import { useTranslate } from "ra-core";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "./use-pwa-install";
import { usePwaInstallAction } from "./use-pwa-install-action";
import { PwaInstallDialog } from "./pwa-install-dialog";
import { cn } from "@/lib/utils";

export const PWA_BANNER_DISMISS_KEY = "savia.pwa.install-banner-dismissed";
export const PWA_BANNER_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isBannerDismissed(): boolean {
  try {
    const raw = localStorage.getItem(PWA_BANNER_DISMISS_KEY);
    if (!raw) return false;
    return Date.now() - Number(raw) < PWA_BANNER_DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Automatic install prompt in the workspace footer. The user-menu item
 * remains available while the footer is reserved for cookie consent.
 */
export function PwaInstallBanner({
  className,
  deferred = false,
}: {
  className?: string;
  deferred?: boolean;
}) {
  const translate = useTranslate();
  const { isInstalled, isInstallable } = usePwaInstall();
  const { platform, dialogOpen, setDialogOpen, handleInstall } =
    usePwaInstallAction();
  const [dismissed, setDismissed] = useState(isBannerDismissed);

  const handleDismiss = useCallback(() => {
    try {
      localStorage.setItem(PWA_BANNER_DISMISS_KEY, String(Date.now()));
    } catch {
      // storage unavailable: dismiss for this session only
    }
    setDismissed(true);
  }, []);

  if (deferred || isInstalled || !isInstallable || dismissed) {
    return null;
  }

  const title = translate("savia.pwa.bannerTitle", {
    _: "Instala Savia en tu dispositivo",
  });
  const subtitle = translate("savia.pwa.bannerSubtitle", {
    _: "Acceso rápido desde tu pantalla de inicio y pantalla completa.",
  });
  const installLabel = translate("savia.pwa.installAppShort", {
    _: "Instalar app",
  });
  const dismissLabel = translate("savia.pwa.bannerDismiss", {
    _: "Ahora no",
  });

  return (
    <>
      <div
        role="region"
        aria-label={title}
        data-slot="workspace-notice"
        className={cn(
          "max-h-[45svh] shrink-0 overflow-y-auto border-t bg-popover px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4 print:hidden",
          className,
        )}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Download className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{title}</p>
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" onClick={handleInstall}>
              {installLabel}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={handleDismiss}
              aria-label={dismissLabel}
              title={dismissLabel}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>

      <PwaInstallDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        platform={platform}
      />
    </>
  );
}
