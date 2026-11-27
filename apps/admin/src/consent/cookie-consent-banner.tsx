import { useCallback, useState } from "react";
import { Cookie, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useTranslate } from "ra-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  getCookieConsent,
  setCookieConsent,
  type CookieConsentPreferences,
  type OptionalCookieCategory,
} from "./cookie-consent-storage";

/**
 * Reserve space in the page until the user makes an explicit consent choice.
 */
export function CookieConsentBanner({
  onDecision,
}: { onDecision?: () => void } = {}) {
  const translate = useTranslate();
  const [decision, setDecision] = useState<CookieConsentPreferences | null>(
    getCookieConsent,
  );
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [optional, setOptional] = useState<
    Record<OptionalCookieCategory, boolean>
  >(decision?.optional ?? { analytics: false, marketing: false });

  const record = useCallback(
    (choices: Record<OptionalCookieCategory, boolean>) => {
      setDecision(setCookieConsent(choices));
      setPreferencesOpen(false);
      onDecision?.();
    },
    [onDecision],
  );

  if (decision) {
    return null;
  }

  const title = translate("savia.consent.title", {
    _: "Usamos cookies",
  });
  const message = translate("savia.consent.message", {
    _: "Usamos cookies esenciales para que la plataforma funcione y, si lo autorizas, cookies analíticas y de marketing para mejorar tu experiencia.",
  });
  const acceptLabel = translate("savia.consent.acceptAll", {
    _: "Aceptar todas",
  });
  const rejectLabel = translate("savia.consent.rejectNonEssential", {
    _: "Solo esenciales",
  });
  const preferencesLabel = translate("savia.consent.preferences", {
    _: "Preferencias",
  });

  return (
    <>
      <div
        role="region"
        aria-label={title}
        data-slot="workspace-notice"
        className="max-h-[45svh] shrink-0 overflow-y-auto border-t bg-popover px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 print:hidden"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Cookie className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{title}</p>
              <p className="mt-1 max-w-[68ch] text-sm leading-normal text-muted-foreground">
                {message}
              </p>
            </div>
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPreferencesOpen(true)}
            >
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              {preferencesLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => record({ analytics: false, marketing: false })}
            >
              <ShieldCheck className="size-4" aria-hidden="true" />
              {rejectLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => record({ analytics: true, marketing: true })}
            >
              {acceptLabel}
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={preferencesOpen} onOpenChange={setPreferencesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{preferencesLabel}</DialogTitle>
            <DialogDescription>
              {translate("savia.consent.preferencesHint", {
                _: "Elige qué cookies no esenciales permites.",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">
                  {translate("savia.consent.categoryEssential", {
                    _: "Cookies esenciales",
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {translate("savia.consent.categoryEssentialHint", {
                    _: "Necesarias para iniciar sesión y navegar. Siempre activas.",
                  })}
                </p>
              </div>
              <Switch checked disabled aria-readonly="true" />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label
                  htmlFor="cookie-consent-analytics"
                  className="text-sm font-medium"
                >
                  {translate("savia.consent.categoryAnalytics", {
                    _: "Cookies analíticas",
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {translate("savia.consent.categoryAnalyticsHint", {
                    _: "Nos ayudan a entender cómo se usa la plataforma.",
                  })}
                </p>
              </div>
              <Switch
                id="cookie-consent-analytics"
                checked={optional.analytics}
                onCheckedChange={(checked) =>
                  setOptional((current) => ({
                    ...current,
                    analytics: checked === true,
                  }))
                }
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label
                  htmlFor="cookie-consent-marketing"
                  className="text-sm font-medium"
                >
                  {translate("savia.consent.categoryMarketing", {
                    _: "Cookies de marketing",
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {translate("savia.consent.categoryMarketingHint", {
                    _: "Se usan para campañas y contenido personalizado.",
                  })}
                </p>
              </div>
              <Switch
                id="cookie-consent-marketing"
                checked={optional.marketing}
                onCheckedChange={(checked) =>
                  setOptional((current) => ({
                    ...current,
                    marketing: checked === true,
                  }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPreferencesOpen(false)}
            >
              {translate("savia.consent.cancel", { _: "Cancelar" })}
            </Button>
            <Button type="button" onClick={() => record(optional)}>
              {translate("savia.consent.save", { _: "Guardar preferencias" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
