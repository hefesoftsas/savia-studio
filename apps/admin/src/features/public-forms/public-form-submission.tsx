import { withRequestTimeout } from "@/api/request-timeout";
import { formatRetryTime, retryDeadline } from "@/api/retry-after";
import { retryIsBlocked, useRetryBlocked } from "@/hooks/use-retry-blocked";
import { intlLocale, useAppLocale, useMessages } from "@/i18n/core";
import { publicFormsMessages } from "@/i18n/locales/public-forms";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { mountAltcha } from "./altcha-widget";

export type PublicSubmissionDefinition = {
  id: string;
  captchaProvider: "turnstile" | "altcha" | "disabled";
  siteKey?: string;
};

/** Token sent when the API runs with local CAPTCHA bypass (never in preview/production). */
export const LOCAL_CAPTCHA_TOKEN = "local-bypass";

export type PublicSubmissionValues = Record<string, string | number | boolean>;

const submissionReceiptSchema = z.object({
  ok: z.literal(true),
  reference: z.string(),
  result: z.unknown().optional(),
});

export type PublicSubmissionController = {
  formRef: React.RefObject<HTMLFormElement | null>;
  captchaElementRef: React.RefObject<HTMLDivElement | null>;
  captcha: string;
  captchaError: string;
  retryVerification(): void;
  error: string;
  pending: boolean;
  retryBlocked: boolean;
  uncertain: boolean;
  duplicate: boolean;
  failed: boolean;
  receipt?: { reference: string; result?: unknown };
  /** Current submission identity for progress polling; null before submit. */
  submissionId: string | null;
  completeFromStatus(id: string, value: unknown): void;
  failFromStatus(id: string): void;
  submit(values: PublicSubmissionValues): Promise<void>;
  startNew(): void;
};

export type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let captchaScript: Promise<TurnstileApi> | undefined;

export function loadCaptcha(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (captchaScript) return captchaScript;
  captchaScript = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    const timeout = window.setTimeout(() => fail(), 20000);
    const fail = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error("Captcha unavailable"));
    };
    script.onload = () => {
      window.clearTimeout(timeout);
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    script.onerror = fail;
    document.head.append(script);
  }).catch((error) => {
    captchaScript = undefined;
    throw error;
  });
  return captchaScript;
}

export function publicError(status: number) {
  if (status === 502)
    return "No se pudo completar la cotización. Intenta más tarde o contacta a quien compartió el enlace.";
  if (status === 503)
    return "Este formulario no está disponible temporalmente. Inténtalo más tarde o contacta a quien compartió el enlace.";
  if (status === 404 || status === 410)
    return "Este enlace ya no está disponible. Pide un enlace nuevo a quien lo compartió.";
  if (status === 429)
    return "Se alcanzó el límite de envíos. Inténtalo más tarde.";
  if (status === 400 || status === 403 || status === 422)
    return "No se pudo validar el envío. Revisa los campos y completa de nuevo la verificación.";
  return "No pudimos confirmar el envío. Puedes reintentar con la misma solicitud después de verificarte de nuevo.";
}

/** Shared anonymous submission lifecycle: CAPTCHA, idempotency, retry, receipt. */
export function usePublicFormSubmission({
  definition,
  endpoint,
}: {
  definition: PublicSubmissionDefinition;
  endpoint: string;
}): PublicSubmissionController {
  const locale = useAppLocale();
  const t = useMessages(publicFormsMessages);
  const captchaElement = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const altchaWidget = useRef<Awaited<ReturnType<typeof mountAltcha>> | null>(
    null,
  );
  const retryProof = useRef(false);
  const form = useRef<HTMLFormElement | null>(null);
  const busy = useRef(false);
  const retryAtRef = useRef<number | undefined>(undefined);
  const activePost = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const submission = useRef<{
    id: string;
    values: PublicSubmissionValues;
  } | null>(null);
  const [captcha, setCaptcha] = useState("");
  const [captchaError, setCaptchaError] = useState("");
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState<number>();
  const retryBlocked = useRetryBlocked(retryAt);
  const retryTime = retryBlocked
    ? formatRetryTime({ status: 429, retryAt }, intlLocale(locale))
    : undefined;
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [failed, setFailed] = useState(false);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    reference: string;
    result?: unknown;
  }>();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      activePost.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (receipt || duplicate || failed) return;
    setCaptchaError("");
    if (!retryProof.current) setCaptcha("");
    let active = true;
    if (definition.captchaProvider === "disabled") {
      // Local development bypass: the API skips verification, so no widget
      // is mounted and the submit action is available immediately.
      if (active) setCaptcha(LOCAL_CAPTCHA_TOKEN);
      return () => {
        active = false;
      };
    }
    if (definition.captchaProvider === "altcha") {
      if (captchaElement.current)
        void mountAltcha(
          captchaElement.current,
          `${endpoint}/challenge`,
          (payload) => {
            if (active && !retryProof.current) {
              setCaptcha(payload);
              setCaptchaError("");
            }
          },
          (state) => {
            if (!active || retryProof.current) return;
            if (state !== "verified") setCaptcha("");
            if (state === "error")
              setCaptchaError(
                "No se pudo completar la verificación. Revisa tu conexión y vuelve a intentarlo.",
              );
          },
          locale,
        )
          .then((instance) => {
            if (active) altchaWidget.current = instance;
            else instance.remove();
          })
          .catch(() => {
            if (active)
              setCaptchaError(
                "No se pudo cargar la verificación. Revisa tu conexión y vuelve a intentarlo.",
              );
          });
      return () => {
        active = false;
        altchaWidget.current?.remove();
        altchaWidget.current = null;
      };
    }
    void loadCaptcha()
      .then((api) => {
        if (!active || !captchaElement.current) return;
        const id = api.render(captchaElement.current, {
          sitekey: definition.siteKey,
          action: "public_submit",
          cData: definition.id,
          language: locale,
          size: "flexible",
          callback: (value: string) => {
            if (active) {
              setCaptcha(value);
              setCaptchaError("");
            }
          },
          "expired-callback": () => {
            if (active) setCaptcha("");
          },
          "error-callback": () => {
            if (active) {
              setCaptcha("");
              setCaptchaError(
                "No se pudo completar la verificación. Revisa tu conexión y vuelve a intentarlo.",
              );
            }
          },
        });
        widget.current = { api, id };
      })
      .catch(() => {
        if (active)
          setCaptchaError(
            "No se pudo cargar la verificación. Revisa tu conexión y vuelve a intentarlo.",
          );
      });
    return () => {
      active = false;
      if (widget.current) {
        widget.current.api.remove(widget.current.id);
        widget.current = null;
      }
    };
  }, [
    locale,
    definition.id,
    definition.siteKey,
    definition.captchaProvider,
    endpoint,
    receipt,
    duplicate,
    failed,
    captchaAttempt,
  ]);

  function retryVerification() {
    if (busy.current) return;
    setCaptchaError("");
    setCaptchaAttempt((attempt) => attempt + 1);
  }

  function setSubmissionRetryAt(deadline: number | undefined) {
    retryAtRef.current = deadline;
    setRetryAt(deadline);
  }

  function settleFromStatus(id: string) {
    if (!alive.current || submission.current?.id !== id) return false;
    const post = activePost.current;
    activePost.current = null;
    setPending(false);
    setUncertain(false);
    setDuplicate(false);
    setError("");
    setSubmissionRetryAt(undefined);
    busy.current = false;
    post?.abort();
    return true;
  }

  function completeFromStatus(id: string, value: unknown) {
    const parsed = submissionReceiptSchema.safeParse(value);
    if (parsed.success && settleFromStatus(id)) setReceipt(parsed.data);
  }

  function failFromStatus(id: string) {
    if (!receipt && settleFromStatus(id)) setFailed(true);
  }

  async function submit(values: PublicSubmissionValues) {
    if (
      busy.current ||
      retryIsBlocked(retryAtRef.current) ||
      !captcha ||
      receipt ||
      duplicate ||
      failed
    )
      return;
    if (!submission.current) {
      submission.current = { id: crypto.randomUUID(), values };
    }
    const current = submission.current;
    const id = current.id;
    setSubmissionId(id);
    busy.current = true;
    setPending(true);
    setError("");
    setSubmissionRetryAt(undefined);
    const abort = new AbortController();
    activePost.current = abort;
    const isCurrentPost = () =>
      alive.current &&
      activePost.current === abort &&
      submission.current?.id === id;
    let keepProof = false;
    try {
      const result = await withRequestTimeout(
        async (signal) => {
          const response = await fetch(endpoint, {
            method: "POST",
            signal,
            credentials: "omit",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              submissionId: id,
              token: captcha,
              values: current.values,
            }),
          });
          if (!response.ok) {
            const body =
              response.status === 409
                ? ((await response.json().catch(() => undefined)) as
                    | { error?: string | { code?: string; message?: string } }
                    | undefined)
                : undefined;
            const detail = body?.error;
            return {
              ok: false as const,
              status: response.status,
              retryAt: retryDeadline(response),
              code: typeof detail === "object" ? detail?.code : undefined,
              message: typeof detail === "string" ? detail : detail?.message,
            };
          }
          return {
            ok: true as const,
            receipt: submissionReceiptSchema.parse(await response.json()),
          };
        },
        180_000,
        abort.signal,
      );
      if (!isCurrentPost()) return;
      if (!result.ok) {
        if (
          result.status === 409 &&
          (result.code === "PUBLIC_SUBMISSION_ALREADY_REGISTERED" ||
            result.message === "Submission identifier already used." ||
            result.message ===
              "Submission already accepted. Do not send it again.")
        ) {
          setDuplicate(true);
          return;
        }
        if (result.status === 408 || result.status >= 500) {
          setUncertain(true);
          keepProof = true;
        } else if (!uncertain) submission.current = null;
        if (result.status === 429) {
          setSubmissionRetryAt(result.retryAt);
          keepProof = retryProof.current;
        }
        const replacedForm =
          result.status === 409 &&
          (result.message === "The form changed. Request a new link." ||
            result.message ===
              "La configuración cambió. Publica nuevamente el formulario." ||
            result.message ===
              "Configura y habilita el cotizador antes de publicar.");
        setError(
          result.retryAt === undefined
            ? publicError(replacedForm ? 404 : result.status)
            : "",
        );
        return;
      }
      setReceipt(result.receipt);
    } catch {
      if (!isCurrentPost()) return;
      keepProof = true;
      setUncertain(true);
      setError(
        definition.captchaProvider === "altcha"
          ? "No pudimos confirmar el envío. Puedes reintentar el mismo envío."
          : "No pudimos confirmar el envío. Puedes reintentar con la misma solicitud después de verificarte de nuevo.",
      );
    } finally {
      if (activePost.current !== abort) return;
      activePost.current = null;
      busy.current = false;
      if (alive.current) {
        setPending(false);
        retryProof.current =
          definition.captchaProvider === "altcha" && keepProof;
        if (definition.captchaProvider === "disabled")
          setCaptcha(LOCAL_CAPTCHA_TOKEN);
        else if (retryProof.current) setCaptcha(captcha);
        else {
          setCaptcha("");
          altchaWidget.current?.reset();
          if (widget.current) widget.current.api.reset(widget.current.id);
        }
      }
    }
  }

  function startNew() {
    retryProof.current = false;
    submission.current = null;
    setSubmissionId(null);
    setReceipt(undefined);
    setDuplicate(false);
    setFailed(false);
    setUncertain(false);
    setError("");
    setSubmissionRetryAt(undefined);
    setCaptcha("");
    form.current?.reset();
  }

  return {
    formRef: form,
    captchaElementRef: captchaElement,
    captcha,
    captchaError,
    retryVerification,
    error: retryTime
      ? t("Se alcanzó el límite de envíos. Inténtalo después de %{time}.", {
          time: retryTime,
        })
      : error,
    pending,
    retryBlocked,
    uncertain,
    duplicate,
    failed,
    receipt,
    submissionId,
    completeFromStatus,
    failFromStatus,
    submit,
    startNew,
  };
}
