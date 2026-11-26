import { useMessages, useAppLocale } from "@/i18n/core";
import { publicFormsMessages } from "@/i18n/locales/public-forms";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withRequestTimeout } from "@/api/request-timeout";
import "./public-forms.css";
import { usePublicFormSubmission } from "./public-form-submission";
import { PublicQuoteForm } from "./public-quote-wizard";

const publicQuotePresentation = z
  .object({
    renderer: z.literal("provider-quote-wizard"),
    entry: z.enum(["wizard", "direct"]),
    products: z
      .array(z.object({ flowId: z.string(), label: z.string() }).strict())
      .min(1)
      .max(20),
  })
  .strict();

const publicFormLogo = z
  .string()
  .max(720_000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
  .optional();

function isSafePublicLogo(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length <= 720_000 &&
    /^data:image\/(png|jpeg|webp);base64,/.test(value)
  );
}

/** Optional per-link logo shown above the public form heading. */
export function PublicFormLogo({ src, alt }: { src: string; alt: string }) {
  if (!isSafePublicLogo(src)) return null;
  return (
    <img
      src={src}
      alt={alt}
      className="public-form-logo"
      loading="lazy"
      decoding="async"
    />
  );
}

const publicDefinition = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(["record", "quote"]),
    logoImage: publicFormLogo,
    captchaProvider: z
      .enum(["turnstile", "altcha", "disabled"])
      .default("turnstile"),
    siteKey: z.string().min(1).optional(),
    presentation: publicQuotePresentation.optional(),
    fields: z
      .array(
        z.object({
          name: z
            .string()
            .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
            .refine(
              (name) =>
                !["__proto__", "constructor", "prototype"].includes(name),
            ),
          label: z.string(),
          type: z.enum([
            "text",
            "number",
            "email",
            "date",
            "boolean",
            "select",
          ]),
          required: z.boolean(),
          options: z
            .array(z.object({ value: z.string(), label: z.string() }))
            .optional(),
        }),
      )
      .max(100)
      .refine(
        (fields) =>
          new Set(fields.map((field) => field.name)).size === fields.length,
      ),
  })
  .refine(
    (value) =>
      value.captchaProvider === "altcha" ||
      value.captchaProvider === "disabled" ||
      Boolean(value.siteKey),
  );
export type PublicFormDefinition = z.infer<typeof publicDefinition>;
type Definition = PublicFormDefinition;

const connectionError = {
  message:
    "No se pudo cargar el formulario. Revisa tu conexión y vuelve a intentarlo.",
  retryable: true,
} as const;
type DefinitionResult =
  | { definition: Definition }
  | { message: keyof typeof publicFormsMessages; retryable: boolean };

/** Standalone entry: intentionally imports no admin services, session or local data modules. */
export function PublicFormPage({ token }: { token: string }) {
  const t = useMessages(publicFormsMessages);
  const locale = useAppLocale();
  const [result, setResult] = useState<DefinitionResult>();
  const [attempt, setAttempt] = useState(0);
  const endpoint = `${(import.meta.env.VITE_SAVIA_API_URL ?? window.location.origin).replace(/\/$/, "")}/api/public/forms/${encodeURIComponent(token)}`;
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void withRequestTimeout<DefinitionResult>(
      async (signal) => {
        const response = await fetch(endpoint, {
          credentials: "omit",
          cache: "no-store",
          signal,
        });
        if (response.status === 404 || response.status === 410)
          return {
            message:
              "Este enlace ya no está disponible. Pide un enlace nuevo a quien lo compartió.",
            retryable: false,
          };
        if (response.status === 503)
          return {
            message:
              "Este formulario no está disponible temporalmente. Inténtalo más tarde o contacta a quien compartió el enlace.",
            retryable: true,
          };
        if (!response.ok) return connectionError;
        const parsed = publicDefinition.safeParse(await response.json());
        return parsed.success
          ? { definition: parsed.data }
          : {
              message:
                "El formulario no está disponible. Pide un enlace nuevo a quien lo compartió.",
              retryable: false,
            };
      },
      undefined,
      controller.signal,
    )
      .then((loaded) => {
        if (!controller.signal.aborted) setResult(loaded);
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult(connectionError);
      });
    return () => controller.abort();
  }, [endpoint, attempt]);
  const definition =
    result && "definition" in result ? result.definition : undefined;
  return (
    <main className="public-form-page" lang={locale}>
      <div className="public-form-shell">
        {!isSafePublicLogo(definition?.logoImage) && (
          <p className="public-form-brand">Savia</p>
        )}
        {!result ? (
          <p role="status">{t("Cargando formulario…")}</p>
        ) : "message" in result ? (
          <div role="alert" className="public-form-notice">
            <h1>{t("Formulario no disponible")}</h1>
            <p>{t(result.message)}</p>
            {result.retryable && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t("Reintentar carga")}
              </Button>
            )}
          </div>
        ) : definition ? (
          definition.kind === "quote" &&
          definition.presentation?.renderer === "provider-quote-wizard" ? (
            <PublicQuoteForm
              key={token}
              definition={definition}
              endpoint={endpoint}
            />
          ) : (
            <SubmissionForm
              key={token}
              definition={definition}
              endpoint={endpoint}
            />
          )
        ) : null}
        <footer className="public-form-footer">
          {t("Formulario compartido mediante Savia.")}
        </footer>
      </div>
    </main>
  );
}
function SubmissionForm({
  definition,
  endpoint,
}: {
  definition: Definition;
  endpoint: string;
}) {
  const t = useMessages(publicFormsMessages);
  const controller = usePublicFormSubmission({ definition, endpoint });
  const {
    formRef,
    captchaElementRef,
    captcha,
    captchaError,
    retryVerification,
    error,
    pending,
    uncertain,
    duplicate,
    receipt,
  } = controller;
  const [parseError, setParseError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formRef.current?.reportValidity()) return;
    if (!captcha || receipt || duplicate) return;
    const values: Record<string, string | number | boolean> = {};
    const data = new FormData(formRef.current);
    for (const field of definition.fields) {
      const value = data.get(field.name);
      if (field.type === "boolean")
        values[field.name] = value === (field.required ? "true" : "on");
      else if (typeof value === "string" && value !== "") {
        if (field.type === "number") {
          const number = Number(value);
          if (!Number.isFinite(number)) {
            setParseError(
              t("Revisa el campo %{field}.", { field: field.label }),
            );
            return;
          }
          values[field.name] = number;
        } else if (
          field.type !== "select" ||
          field.options?.some((option) => option.value === value)
        )
          values[field.name] = value;
      }
    }
    setParseError("");
    await controller.submit(values);
  }

  function startNew() {
    setParseError("");
    controller.startNew();
  }

  const visibleError = parseError || error;

  return (
    <>
      <header className="public-form-heading">
        {isSafePublicLogo(definition.logoImage) && (
          <PublicFormLogo src={definition.logoImage} alt={definition.title} />
        )}
        <h1>{definition.title}</h1>
        {definition.description && <p>{definition.description}</p>}
      </header>
      {receipt ? (
        <section
          aria-labelledby="public-form-success"
          className="public-form-notice"
          role="status"
        >
          <h2 id="public-form-success">{t("Solicitud recibida")}</h2>
          <p>
            {t(
              "Conserva esta referencia para consultar con quien compartió el formulario.",
            )}
          </p>
          <p className="public-form-reference">{receipt.reference}</p>
          {typeof receipt.result === "string" ||
          typeof receipt.result === "number" ? (
            <p>{String(receipt.result)}</p>
          ) : null}
          <Button type="button" variant="outline" onClick={startNew}>
            {t("Iniciar otro envío")}
          </Button>
        </section>
      ) : duplicate ? (
        <section className="public-form-notice" role="status">
          <h2>{t("Envío registrado")}</h2>
          <p>
            {t(
              "Este envío ya fue recibido o está en proceso. No lo vuelvas a enviar.",
            )}
          </p>
          <p>
            {t(
              "Si necesitas confirmar el resultado, contacta a quien compartió el enlace.",
            )}
          </p>
          <Button type="button" variant="outline" onClick={startNew}>
            {t("Iniciar otro envío")}
          </Button>
        </section>
      ) : (
        <form
          ref={formRef}
          onSubmit={submit}
          className="public-form-fields"
          aria-busy={pending}
        >
          <p className="public-form-help">
            {t("Los campos marcados con * son obligatorios.")}
          </p>
          <fieldset disabled={pending || uncertain}>
            {definition.fields.map((field) => (
              <div className="public-form-field" key={field.name}>
                <label htmlFor={`public-${field.name}`}>
                  {field.label}
                  {field.required ? " *" : ""}
                </label>
                {field.type === "boolean" && field.required ? (
                  <select
                    id={`public-${field.name}`}
                    name={field.name}
                    required
                    defaultValue=""
                  >
                    <option value="">{t("Selecciona una opción")}</option>
                    <option value="true">{t("Sí")}</option>
                    <option value="false">{t("No")}</option>
                  </select>
                ) : field.type === "boolean" ? (
                  <input
                    id={`public-${field.name}`}
                    name={field.name}
                    type="checkbox"
                    required={field.required}
                  />
                ) : field.type === "select" ? (
                  <select
                    id={`public-${field.name}`}
                    name={field.name}
                    required={field.required}
                    defaultValue=""
                  >
                    <option value="">{t("Selecciona una opción")}</option>
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={`public-${field.name}`}
                    name={field.name}
                    type={field.type}
                    required={field.required}
                    step={field.type === "number" ? "any" : undefined}
                    autoComplete="off"
                  />
                )}
              </div>
            ))}
          </fieldset>
          <div
            ref={captchaElementRef}
            aria-label={t("Verificación de seguridad")}
          />
          {captchaError && (
            <div className="grid justify-items-start gap-2">
              <p role="alert" className="public-form-error">
                {Object.hasOwn(publicFormsMessages, captchaError)
                  ? t(captchaError as keyof typeof publicFormsMessages)
                  : captchaError}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={retryVerification}
                disabled={pending}
              >
                {t("Reintentar verificación")}
              </Button>
            </div>
          )}
          {visibleError && (
            <p role="alert" className="public-form-error">
              {Object.hasOwn(publicFormsMessages, visibleError)
                ? t(visibleError as keyof typeof publicFormsMessages)
                : visibleError}
            </p>
          )}
          <Button type="submit" disabled={!captcha || pending}>
            {pending
              ? t("Enviando…")
              : uncertain
                ? t("Reintentar el mismo envío")
                : t("Enviar solicitud")}
          </Button>
          {!captcha && !captchaError && (
            <p className="public-form-help">
              {t("Completa la verificación de seguridad para enviar.")}
            </p>
          )}
        </form>
      )}
    </>
  );
}
