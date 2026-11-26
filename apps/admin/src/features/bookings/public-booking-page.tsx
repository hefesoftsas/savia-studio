import { formatRetryTime } from "@/api/retry-after";
import { intlLocale, useAppLocale, useMessages } from "@/i18n/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadCaptcha } from "../public-forms/public-form-submission";
import { mountAltcha } from "../public-forms/altcha-widget";
import { bookingMessages } from "./booking-messages";
import { publicBookingWizardMessages } from "./public-booking-wizard-messages";
import { PublicBookingAvailability } from "./public-booking-availability";
import { PublicBookingSummary } from "./public-booking-summary";
import {
  canRetryPublicBookingLoad,
  publicBookingRequest as publicRequest,
  type PublicBookingApiError,
} from "./public-booking-request";
import type { BookingLinkScope, BookingSelection } from "./booking-types";
import {
  BookingConference,
  type BookingConferenceState,
} from "./booking-conference";

type PublicCatalog = {
  id: string;
  title: string;
  description: string;
  timeZone: string;
  cancellationMinutes: number;
  horizonDays: number;
  leadMinutes: number;
  linkScope: BookingLinkScope;
  fixedProfessionalId: string | null;
  fixedServiceId: string | null;
  services: Array<{
    id: string;
    name: string;
    description: string;
    durationMinutes: number;
    professionalIds: string[];
  }>;
  professionals: Array<{ id: string; name: string }>;
  captcha: {
    captchaProvider: "turnstile" | "altcha" | "disabled";
    siteKey?: string;
  };
};
const createIdempotencyKey = () =>
  globalThis.crypto?.randomUUID?.() ??
  `booking-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type BookingSubmission = {
  key: string;
  body: string;
  selection: BookingSelection;
};

export function PublicBookingPage({ token }: { token: string }) {
  return <PublicBookingLink key={token} token={token} />;
}

function PublicBookingLink({ token }: { token: string }) {
  const t = useMessages(bookingMessages);
  const wt = useMessages(publicBookingWizardMessages);
  const locale = useAppLocale();
  const captchaElement = useRef<HTMLDivElement>(null);
  const idempotency = useRef<
    | { signature: string; key: string; customerLocale: typeof locale }
    | undefined
  >(undefined);
  const [catalog, setCatalog] = useState<PublicCatalog>();
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [catalogLoadError, setCatalogLoadError] = useState<
    "unavailable" | "retryable" | "other"
  >();
  const [error, setError] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [displayTimeZone, setDisplayTimeZone] = useState("");
  const [selection, setSelection] = useState<BookingSelection>();
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaError, setCaptchaError] = useState("");
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const [slotsAttempt, setSlotsAttempt] = useState(0);
  const [step, setStep] = useState(1);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStepRef = useRef(step);
  const [busy, setBusy] = useState(false);
  const [unconfirmedBooking, setUnconfirmedBooking] =
    useState<BookingSubmission>();
  const [reservation, setReservation] = useState<{
    selection: BookingSelection;
    status: "confirmed" | "cancelled";
    managementUrl: string;
    conference?: BookingConferenceState;
  }>();

  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    stepHeadingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const controller = new AbortController();
    void publicRequest<PublicCatalog>(
      `/api/public/bookings/${encodeURIComponent(token)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        data.linkScope ??= { kind: "team" };
        data.fixedProfessionalId ??= null;
        data.fixedServiceId ??= null;
        data.horizonDays ??= 30;
        data.leadMinutes ??= 0;
        setCatalog(data);
        setDisplayTimeZone(data.timeZone);
        const nextServiceId =
          data.fixedServiceId ??
          (data.services.length === 1 ? data.services[0].id : "");
        const nextEligible =
          data.services.find((service) => service.id === nextServiceId)
            ?.professionalIds ?? [];
        const nextProfessionalId =
          data.fixedProfessionalId ??
          (nextEligible.length === 1 ? nextEligible[0] : "");
        setServiceId(nextServiceId);
        setProfessionalId(nextProfessionalId);
        setSelection(undefined);
        const chooseService = !data.fixedServiceId && data.services.length > 1;
        const chooseProfessional =
          data.linkScope.kind === "team" && nextEligible.length > 1;
        setStep(chooseService || chooseProfessional ? 1 : 2);
        if (data.captcha.captchaProvider === "disabled")
          setCaptchaToken("local-bypass");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = (error as PublicBookingApiError | undefined)?.status;
        setCatalogLoadError(
          status === 404 || status === 410
            ? "unavailable"
            : canRetryPublicBookingLoad(error)
              ? "retryable"
              : "other",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, loadAttempt]);

  useEffect(() => {
    if (
      !catalog ||
      step !== 3 ||
      catalog.captcha.captchaProvider === "disabled" ||
      reservation
    )
      return;
    setCaptchaToken("");
    setCaptchaError("");
    const activeCatalog = catalog;
    let active = true;
    let widget: { remove(): void } | undefined;
    const verified = (value: string) => {
      if (active) {
        setCaptchaToken(value);
        setCaptchaError("");
      }
    };
    const failed = () => {
      if (active) {
        setCaptchaToken("");
        setCaptchaError(
          t("Verification could not load. Check your connection and retry."),
        );
      }
    };
    async function mountCaptcha() {
      if (!captchaElement.current) return;
      if (activeCatalog.captcha.captchaProvider === "altcha") {
        const instance = await mountAltcha(
          captchaElement.current,
          `/api/public/bookings/${encodeURIComponent(token)}/challenge`,
          verified,
          (state) => {
            if (active && state !== "verified") setCaptchaToken("");
            if (state === "error") failed();
          },
          locale,
        );
        if (active) widget = instance;
        else instance.remove();
      } else {
        const api = await loadCaptcha();
        if (!active || !captchaElement.current) return;
        const id = api.render(captchaElement.current, {
          sitekey: activeCatalog.captcha.siteKey,
          action: "public_submit",
          cData: activeCatalog.id,
          language: locale,
          size: "flexible",
          callback: verified,
          "expired-callback": () => verified(""),
          "error-callback": failed,
        });
        widget = { remove: () => api.remove(id) };
      }
    }
    void mountCaptcha().catch(failed);
    return () => {
      active = false;
      widget?.remove();
    };
  }, [catalog, locale, token, reservation, captchaAttempt, step, t]);

  const selectedService = useMemo(
    () => catalog?.services.find((service) => service.id === serviceId),
    [catalog, serviceId],
  );
  const eligibleProfessionals = useMemo(
    () =>
      catalog?.professionals.filter((person) =>
        selectedService?.professionalIds.includes(person.id),
      ) ?? [],
    [catalog, selectedService],
  );

  function reloadCatalog() {
    setLoading(true);
    setCatalog(undefined);
    setAvailabilityReady(false);
    setCaptchaToken("");
    setLoadAttempt((attempt) => attempt + 1);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !catalog ||
      step !== 3 ||
      !serviceId ||
      !professionalId ||
      !selection ||
      selection.serviceId !== serviceId ||
      selection.professionalId !== professionalId ||
      !captchaToken ||
      !availabilityReady ||
      busy
    )
      return;
    const body = {
      serviceId: selection.serviceId,
      professionalId: selection.professionalId,
      startsAt: selection.slot.startsAt,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim().toLowerCase(),
      captchaToken,
    };
    const signature = JSON.stringify({
      serviceId,
      professionalId,
      startsAt: Date.parse(body.startsAt),
      customerName: body.customerName,
      customerEmail: body.customerEmail,
    });
    if (!idempotency.current || idempotency.current.signature !== signature)
      idempotency.current = {
        signature,
        key: createIdempotencyKey(),
        customerLocale: locale,
      };
    void sendBooking({
      key: idempotency.current.key,
      body: JSON.stringify({
        ...body,
        customerLocale: idempotency.current.customerLocale,
      }),
      selection,
    });
  }

  async function sendBooking(submission: BookingSubmission) {
    if (!catalog || busy) return;
    setBusy(true);
    setUnconfirmedBooking(undefined);
    setError("");
    try {
      const result = await publicRequest<{
        reservation: {
          startsAt: string;
          endsAt: string;
          status: "confirmed" | "cancelled";
          conference?: BookingConferenceState;
        };
        managementUrl: string;
      }>(`/api/public/bookings/${encodeURIComponent(token)}/reservations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": submission.key,
        },
        body: submission.body,
      });
      setReservation({
        selection: {
          ...submission.selection,
          slot: {
            startsAt: result.reservation.startsAt,
            endsAt: result.reservation.endsAt,
          },
        },
        status: result.reservation.status,
        conference: result.reservation.conference,
        managementUrl: result.managementUrl,
      });
    } catch (requestError) {
      const { status, code } = (requestError as PublicBookingApiError) ?? {};
      const requiresVerification =
        catalog.captcha.captchaProvider !== "disabled";
      const dailyLimit = status === 429 && code === "BOOKING_DAILY_LIMIT";
      const outcomeUncertain =
        typeof status !== "number" || status === 408 || status >= 500;
      if (
        requiresVerification &&
        (status === 403 || status === 409 || dailyLimit || outcomeUncertain)
      ) {
        setCaptchaToken("");
        setCaptchaAttempt((attempt) => attempt + 1);
      }
      if (status === 403 && requiresVerification) {
        setError(t("Complete verification again to retry your booking."));
        return;
      }
      if (status === 429) {
        const retryTime = formatRetryTime(requestError, intlLocale(locale));
        setError(
          dailyLimit
            ? retryTime
              ? t(
                  "The daily booking limit was reached. Try again after %{time}.",
                  { time: retryTime },
                )
              : t(
                  "The daily booking limit was reached. Try again after midnight UTC.",
                )
            : retryTime
              ? t("Too many booking requests. Try again after %{time}.", {
                  time: retryTime,
                })
              : t("Too many booking requests. Try again shortly."),
        );
        return;
      }
      if (status === 404 || status === 410) {
        setError(t("Booking options changed. Review the available options."));
        reloadCatalog();
        return;
      }
      if (outcomeUncertain) setUnconfirmedBooking(submission);
      if (status === 409) {
        setSelection(undefined);
        setSlotsAttempt((attempt) => attempt + 1);
        setStep(2);
      }
      setError(
        status === 409
          ? t(
              code === "BOOKING_TIME_CONFLICT"
                ? "That time conflicts with another meeting or appointment. Choose another available time."
                : "That time is no longer available. Choose another available time.",
            )
          : t(
              "Your booking could not be confirmed. Retry with the same request.",
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="mx-auto grid max-w-2xl gap-4 px-4 py-10" role="status">
        <div className="h-8 w-56 animate-pulse rounded bg-muted" />
        <div className="h-28 animate-pulse rounded bg-muted" />
        <span className="sr-only">{t("Loading booking settings…")}</span>
      </main>
    );
  if (!catalog)
    return (
      <main className="mx-auto grid max-w-2xl gap-3 px-4 py-10">
        <p role="alert" className="text-sm text-destructive">
          {catalogLoadError === "unavailable"
            ? t(
                "This booking link is no longer available. Ask the booking owner for a new link.",
              )
            : t("Booking settings could not be loaded.")}
        </p>
        {catalogLoadError === "retryable" && (
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={reloadCatalog}
          >
            {t("Retry")}
          </Button>
        )}
      </main>
    );
  if (reservation)
    return (
      <main className="mx-auto grid max-w-2xl gap-5 px-4 py-10">
        <h1 className="text-2xl font-semibold">
          {reservation.status === "cancelled"
            ? t("Appointment cancelled")
            : t("Appointment confirmed")}
        </h1>
        <PublicBookingSummary
          catalog={catalog}
          selection={reservation.selection}
        />
        <BookingConference
          conference={reservation.conference}
          status={reservation.status}
          pendingAction="manage"
        />
        <a
          className="underline underline-offset-4"
          href={reservation.managementUrl}
        >
          {reservation.status === "cancelled"
            ? t("View appointment")
            : t("Manage or cancel this appointment")}
        </a>
        {reservation.status === "confirmed" && (
          <p className="text-sm text-muted-foreground">
            {t("Cancellation cutoff (minutes)")}: {catalog.cancellationMinutes}
          </p>
        )}
      </main>
    );

  const disabledCaptcha = catalog.captcha.captchaProvider === "disabled";
  const selectedProfessional = (
    catalog.fixedProfessionalId ? catalog.professionals : eligibleProfessionals
  ).find(
    (person) => person.id === (catalog.fixedProfessionalId ?? professionalId),
  );
  const serviceSelectionNeeded =
    !catalog.fixedServiceId && catalog.services.length > 1;
  const professionalSelectionNeeded =
    catalog.linkScope.kind === "team" &&
    (serviceSelectionNeeded
      ? catalog.services.some((service) => service.professionalIds.length > 1)
      : eligibleProfessionals.length > 1);
  const selectionStep = serviceSelectionNeeded || professionalSelectionNeeded;
  const stepNames = selectionStep
    ? [
        serviceSelectionNeeded && professionalSelectionNeeded
          ? wt("Service and professional")
          : serviceSelectionNeeded
            ? wt("Service")
            : wt("Professional"),
        wt("Availability"),
        wt("Your details"),
      ]
    : [wt("Availability"), wt("Your details")];
  const visibleStep =
    step === 1 ? 1 : step === 2 ? (selectionStep ? 2 : 1) : stepNames.length;
  const canContinue = Boolean(
    selection &&
    selection.serviceId === serviceId &&
    selection.professionalId === professionalId &&
    availabilityReady,
  );
  return (
    <main className="mx-auto grid max-w-3xl gap-5 px-4 py-6 md:gap-7 md:py-12">
      <header className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {catalog.title}
        </h1>
        <p className="max-w-prose whitespace-pre-wrap text-muted-foreground">
          {catalog.description}
        </p>
        {selectedProfessional && (
          <p className="font-medium">
            {t("Booking with %{professional}", {
              professional: selectedProfessional.name,
            })}
          </p>
        )}
        {selectedService && (
          <p className="text-sm text-muted-foreground">
            {selectedService.name} · {selectedService.durationMinutes} min
          </p>
        )}
      </header>
      <nav aria-label={wt("Booking progress")}>
        <ol
          className={`grid ${stepNames.length === 3 ? "grid-cols-3" : "grid-cols-2"} border-b`}
          aria-label={wt("Booking progress")}
        >
          {stepNames.map((name, index) => {
            const number = index + 1;
            const current = visibleStep === number;
            const complete = visibleStep > number;
            return (
              <li
                key={name}
                aria-current={current ? "step" : undefined}
                className={`border-b-2 px-1 pb-3 text-xs leading-snug sm:text-sm ${
                  current
                    ? "border-primary font-medium text-foreground"
                    : complete
                      ? "border-primary/50 text-foreground"
                      : "border-transparent text-muted-foreground"
                }`}
              >
                <span className="mb-1 block text-xs tabular-nums">
                  {number} / {stepNames.length}
                </span>
                {name}
              </li>
            );
          })}
        </ol>
      </nav>
      <form className="grid gap-6" onSubmit={submit}>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <fieldset disabled={busy} className="grid min-w-0 gap-6 border-0 p-0">
          {step === 2 && unconfirmedBooking && (
            <section className="grid gap-3 rounded-lg border bg-card p-4">
              <p className="text-sm">
                {t("The previous booking could not be confirmed.")}
              </p>
              <PublicBookingSummary
                catalog={catalog}
                selection={unconfirmedBooking.selection}
              />
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={() => void sendBooking(unconfirmedBooking)}
              >
                {t("Retry previous booking")}
              </Button>
            </section>
          )}
          {step === 1 && selectionStep && (
            <section
              aria-labelledby="booking-step-heading"
              className="grid gap-5"
            >
              <h2
                id="booking-step-heading"
                ref={stepHeadingRef}
                tabIndex={-1}
                className="text-lg font-semibold focus:outline-none"
              >
                {wt("Choose your appointment")}
              </h2>
              {!catalog.fixedServiceId && catalog.services.length > 1 && (
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-sm font-medium">
                    {t("Service")}
                  </legend>
                  {catalog.services.map((service) => (
                    <label
                      key={service.id}
                      className={`flex min-h-16 cursor-pointer gap-3 rounded-md border p-3 ${service.id === serviceId ? "border-primary bg-accent/40" : "bg-background"}`}
                    >
                      <input
                        type="radio"
                        name="booking-service"
                        value={service.id}
                        checked={service.id === serviceId}
                        className="mt-1 size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onChange={() => {
                          setError("");
                          const eligible = service.professionalIds;
                          setServiceId(service.id);
                          setProfessionalId(
                            catalog.fixedProfessionalId ??
                              (eligible.length === 1 ? eligible[0] : ""),
                          );
                          setSelection(undefined);
                        }}
                      />
                      <span className="grid gap-1">
                        <span className="font-medium">
                          {service.name} · {service.durationMinutes} min
                        </span>
                        {service.description && (
                          <span className="text-sm text-muted-foreground">
                            {service.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {catalog.linkScope.kind === "team" &&
                eligibleProfessionals.length > 1 && (
                  <label className="grid gap-2 text-sm font-medium">
                    {t("Professional")}
                    <select
                      className="h-11 min-w-0 rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
                      required
                      disabled={!selectedService}
                      value={professionalId}
                      onChange={(event) => {
                        setError("");
                        setProfessionalId(event.target.value);
                        setSelection(undefined);
                      }}
                    >
                      <option value="">{t("Choose a professional")}</option>
                      {eligibleProfessionals.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              <div className="flex justify-end border-t pt-5">
                <Button
                  type="button"
                  className="h-11 min-w-32"
                  disabled={!serviceId || !professionalId}
                  onClick={() => setStep(2)}
                >
                  {wt("Continue")}
                </Button>
              </div>
            </section>
          )}
          {step === 2 && (
            <section
              aria-labelledby="booking-step-heading"
              className="grid gap-5"
            >
              <h2
                id="booking-step-heading"
                ref={stepHeadingRef}
                tabIndex={-1}
                className="text-lg font-semibold focus:outline-none"
              >
                {wt("Choose a day and time")}
              </h2>
              {!serviceId || !professionalId ? (
                <p role="alert" className="text-sm text-destructive">
                  {t("Choose a service and professional to see availability.")}
                </p>
              ) : (
                <PublicBookingAvailability
                  token={token}
                  catalog={catalog}
                  serviceId={serviceId}
                  professionalId={professionalId}
                  displayTimeZone={displayTimeZone || catalog.timeZone}
                  onTimeZoneChange={(zone) => {
                    setError("");
                    setDisplayTimeZone(zone);
                  }}
                  value={selection}
                  onChange={(next) => {
                    if (selection?.slot.startsAt !== next?.slot.startsAt)
                      setError("");
                    setSelection(next);
                  }}
                  onReadyChange={setAvailabilityReady}
                  hideHeading
                  refreshKey={slotsAttempt}
                />
              )}
              <div className="flex items-center justify-between border-t pt-5">
                {selectionStep && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 min-w-24"
                    onClick={() => setStep(1)}
                  >
                    {wt("Back")}
                  </Button>
                )}
                <Button
                  type="button"
                  className="h-11 min-w-32"
                  disabled={!canContinue}
                  onClick={() => setStep(3)}
                >
                  {wt("Continue")}
                </Button>
              </div>
            </section>
          )}
          {step === 3 && (
            <section
              aria-labelledby="booking-step-heading"
              className="grid gap-5"
            >
              <div className="grid gap-1">
                <h2
                  id="booking-step-heading"
                  ref={stepHeadingRef}
                  tabIndex={-1}
                  className="text-lg font-semibold focus:outline-none"
                >
                  {wt("Your details")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {wt("Review your appointment and add your contact details.")}
                </p>
              </div>
              <PublicBookingSummary catalog={catalog} selection={selection} />
              <div className="grid gap-5 sm:grid-cols-2">
                <label className="grid gap-2 text-sm font-medium sm:col-span-2">
                  {t("Your name")}
                  <Input
                    className="h-11 text-base"
                    required
                    autoComplete="name"
                    maxLength={200}
                    value={customerName}
                    onChange={(event) => {
                      setError("");
                      setCustomerName(event.target.value);
                    }}
                  />
                </label>
                <label className="grid gap-2 text-sm font-medium sm:col-span-2">
                  {t("Email")}
                  <Input
                    className="h-11 text-base"
                    required
                    type="email"
                    autoComplete="email"
                    maxLength={320}
                    value={customerEmail}
                    onChange={(event) => {
                      setError("");
                      setCustomerEmail(event.target.value);
                    }}
                  />
                </label>
              </div>
              {!disabledCaptcha && (
                <div className="grid gap-1.5">
                  <div
                    ref={captchaElement}
                    aria-label="CAPTCHA"
                    className="min-h-16 max-w-full overflow-hidden"
                  />
                  {captchaError && (
                    <div className="grid gap-2">
                      <p role="alert" className="text-sm text-destructive">
                        {captchaError}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        onClick={() => {
                          stepHeadingRef.current?.focus();
                          setCaptchaAttempt((attempt) => attempt + 1);
                        }}
                      >
                        {t("Retry verification")}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between border-t pt-5">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-w-24"
                  onClick={() => setStep(2)}
                >
                  {wt("Back")}
                </Button>
                <Button
                  type="submit"
                  className="h-11 min-w-40"
                  disabled={
                    busy || !availabilityReady || !captchaToken || !selection
                  }
                >
                  {busy
                    ? t("Loading booking settings…")
                    : error
                      ? t("Retry booking")
                      : t("Book appointment")}
                </Button>
              </div>
            </section>
          )}
        </fieldset>
      </form>
    </main>
  );
}
