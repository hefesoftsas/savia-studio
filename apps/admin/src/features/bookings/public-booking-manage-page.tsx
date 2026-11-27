import { formatRetryTime } from "@/api/retry-after";
import { Button } from "@/components/ui/button";
import {
  retryIsBlocked,
  useRetryBlocked,
  useRetryDeadline,
} from "@/hooks/use-retry-blocked";
import { useMessages, useAppLocale, intlLocale } from "@/i18n/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { bookingMessages } from "./booking-messages";
import { PublicBookingAvailability } from "./public-booking-availability";
import { PublicBookingSummary } from "./public-booking-summary";
import {
  canRetryPublicBookingLoad,
  publicBookingRequest as publicRequest,
  type PublicBookingApiError as ApiError,
} from "./public-booking-request";
import type { BookingSelection } from "./booking-types";
import {
  BookingConference,
  type BookingConferenceState,
} from "./booking-conference";

type Reservation = {
  id: string;
  serviceId: string;
  professionalId: string;
  serviceName: string;
  professionalName: string;
  startsAt: string;
  endsAt: string;
  customerName: string;
  customerEmail: string;
  status: "confirmed" | "cancelled";
  version: number;
  deliveryStatus: string;
  calendarStatus: string;
  conference?: BookingConferenceState;
};
type ManageBootstrap = {
  reservation: Reservation;
  publicUrl: string | null;
  timeZone: string;
  cancellationMinutes: number;
  horizonDays: number;
  leadMinutes: number;
  canReschedule: boolean;
};
function timeForZone(iso: string, zone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
    timeZoneName: "short",
  }).format(new Date(iso));
}

function rateLimitError(reason: unknown): ApiError | undefined {
  const error = reason as ApiError | undefined;
  return error?.status === 429 ? error : undefined;
}

function isAppointmentUnavailable(reason: unknown): boolean {
  const status = (reason as ApiError | undefined)?.status;
  return status === 404 || status === 410;
}

export function PublicBookingManagePage({ token }: { token: string }) {
  return <PublicBookingManagementLink key={token} token={token} />;
}

function PublicBookingManagementLink({ token }: { token: string }) {
  const t = useMessages(bookingMessages);
  const appointmentMoved = t(
    "This appointment was rescheduled. Review the updated time before making another change.",
  );
  const locale = useAppLocale();
  const managePath = `/api/public/bookings/manage/${encodeURIComponent(token)}`;
  const [bootstrap, setBootstrap] = useState<ManageBootstrap>();
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [canRetryLoad, setCanRetryLoad] = useState(false);
  const [error, setError] = useState("");
  const [readLimit, setReadLimit] = useState<ApiError>();
  const {
    retryAt: readRetryAt,
    blocked: readBlocked,
    remember: rememberReadDeadline,
    isBlockedNow: readIsBlocked,
  } = useRetryDeadline();
  const [writeLimit, setWriteLimit] = useState<ApiError>();
  const writeBlocked = useRetryBlocked(writeLimit?.retryAt);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [needsVerification, setNeedsVerification] = useState(false);
  const [closedDeadline, setClosedDeadline] = useState<number>();
  const [rescheduling, setRescheduling] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [rescheduleConfirmation, setRescheduleConfirmation] = useState<{
    startsAt: string;
    displayTimeZone: string;
  }>();
  const [selection, setSelection] = useState<BookingSelection>();
  const [displayTimeZone, setDisplayTimeZone] = useState("");
  const [slotsReady, setSlotsReady] = useState(false);
  const [availabilityRefreshKey, setAvailabilityRefreshKey] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const refreshSequence = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void publicRequest<ManageBootstrap>(managePath, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) {
          setBootstrap(data);
          setDisplayTimeZone(data.timeZone);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const limit = rateLimitError(error);
          rememberReadDeadline(limit?.retryAt);
          setReadLimit(limit);
          setCanRetryLoad(canRetryPublicBookingLoad(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [managePath, loadAttempt, rememberReadDeadline]);

  useEffect(() => {
    if (rescheduling) stepHeading.current?.focus();
  }, [rescheduling, reviewing]);

  const reservation = bootstrap?.reservation;
  const changeDeadline =
    bootstrap && reservation?.status === "confirmed"
      ? Date.parse(reservation.startsAt) - bootstrap.cancellationMinutes * 60000
      : undefined;

  useEffect(() => {
    if (
      changeDeadline === undefined ||
      !Number.isFinite(changeDeadline) ||
      changeDeadline < Date.now()
    )
      return;
    let timer: number;
    function scheduleDeadline(deadline: number) {
      const remaining = deadline - Date.now() + 1;
      if (remaining <= 0) {
        setClosedDeadline(deadline);
        return;
      }
      timer = window.setTimeout(
        () => scheduleDeadline(deadline),
        Math.min(remaining, 2_147_483_647),
      );
    }
    scheduleDeadline(changeDeadline);
    return () => window.clearTimeout(timer);
  }, [changeDeadline]);

  function checkChangeDeadline() {
    if (changeDeadline === undefined) return false;
    if (Date.now() <= changeDeadline) return true;
    setClosedDeadline(changeDeadline);
    return false;
  }

  function updateBootstrap(next: ManageBootstrap) {
    setBootstrap((current) => {
      if (
        !current ||
        next.reservation.version < current.reservation.version ||
        (current.reservation.status === "cancelled" &&
          next.reservation.status !== "cancelled")
      )
        return current;
      return next;
    });
  }
  function updateReservation(nextReservation: Reservation) {
    setBootstrap((current) => {
      if (!current) return current;
      if (
        nextReservation.version < current.reservation.version ||
        (current.reservation.status === "cancelled" &&
          nextReservation.status !== "cancelled")
      )
        return current;
      return { ...current, reservation: nextReservation };
    });
  }
  function invalidateRefresh() {
    refreshSequence.current += 1;
    setRefreshing(false);
  }
  function closeRescheduleReview(message = "") {
    setSelection(undefined);
    setReviewing(false);
    setRescheduling(false);
    setError(message);
  }

  function requireVerification() {
    closeRescheduleReview();
    setRefreshError("");
    setNeedsVerification(true);
  }

  function showUnavailableAppointment() {
    invalidateRefresh();
    setBootstrap(undefined);
    setCanRetryLoad(false);
    setRescheduleConfirmation(undefined);
    closeRescheduleReview();
  }

  function throttledMessage(
    limit: Pick<ApiError, "status" | "retryAt"> | undefined,
    blocked: boolean,
  ) {
    if (!limit) return;
    const retryTime = blocked
      ? formatRetryTime(limit, intlLocale(locale))
      : undefined;
    if (retryTime)
      return t("Too many booking requests. Try again after %{time}.", {
        time: retryTime,
      });
    if (limit.retryAt === undefined)
      return t("Too many booking requests. Try again shortly.");
  }
  const readLimitMessage = throttledMessage(
    readBlocked ? { status: 429, retryAt: readRetryAt } : readLimit,
    readBlocked,
  );
  const writeLimitMessage = throttledMessage(writeLimit, writeBlocked);

  async function refreshAppointment() {
    if (!bootstrap || readIsBlocked()) return;
    const previous = bootstrap.reservation;
    const request = ++refreshSequence.current;
    setRefreshing(true);
    setReadLimit(undefined);
    setRefreshError("");
    try {
      const data = await publicRequest<ManageBootstrap>(managePath);
      if (request !== refreshSequence.current) return;
      if (
        data.reservation.id !== previous.id ||
        data.reservation.version < previous.version
      )
        throw new Error("The appointment refresh returned stale data");
      updateBootstrap(data);
      setNeedsVerification(false);

      const moved =
        data.reservation.status === "confirmed" &&
        Date.parse(data.reservation.startsAt) !== Date.parse(previous.startsAt);
      if (
        moved ||
        !data.canReschedule ||
        data.reservation.status !== "confirmed"
      )
        closeRescheduleReview(moved ? appointmentMoved : "");
    } catch (reason) {
      const limit = rateLimitError(reason);
      rememberReadDeadline(limit?.retryAt);
      if (request !== refreshSequence.current) return;
      if (isAppointmentUnavailable(reason)) showUnavailableAppointment();
      else if (limit) setReadLimit(limit);
      else
        setRefreshError(
          t("The appointment could not be refreshed. Try again."),
        );
    } finally {
      if (request === refreshSequence.current) setRefreshing(false);
    }
  }
  const summaryCatalog = useMemo(
    () =>
      bootstrap
        ? {
            timeZone: bootstrap.timeZone,
            services: [
              {
                id: bootstrap.reservation.serviceId,
                name: bootstrap.reservation.serviceName,
                durationMinutes: Math.round(
                  (Date.parse(bootstrap.reservation.endsAt) -
                    Date.parse(bootstrap.reservation.startsAt)) /
                    60000,
                ),
              },
            ],
            professionals: [
              {
                id: bootstrap.reservation.professionalId,
                name: bootstrap.reservation.professionalName,
              },
            ],
          }
        : undefined,
    [bootstrap],
  );

  function deferThrottledWrite(reason: unknown) {
    const failure = rateLimitError(reason);
    if (!failure) return false;
    setWriteLimit(failure);
    return true;
  }

  async function verifyAppointmentAfterChange(previous: Reservation) {
    if (readIsBlocked()) {
      requireVerification();
      return;
    }
    setReadLimit(undefined);
    try {
      const current = await publicRequest<ManageBootstrap>(managePath);
      if (
        current.reservation?.id === previous.id &&
        current.reservation.version >= previous.version
      ) {
        updateBootstrap(current);
        return current;
      }
    } catch (reason) {
      if (isAppointmentUnavailable(reason)) {
        showUnavailableAppointment();
        return;
      }
      const limit = rateLimitError(reason);
      rememberReadDeadline(limit?.retryAt);
      setReadLimit(limit);
    }
    requireVerification();
  }

  async function cancel() {
    if (
      !bootstrap ||
      busy ||
      needsVerification ||
      retryIsBlocked(writeLimit?.retryAt) ||
      !checkChangeDeadline()
    )
      return;
    invalidateRefresh();
    setBusy(true);
    setWriteLimit(undefined);
    setError("");
    try {
      const nextReservation = await publicRequest<Reservation>(
        `${managePath}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: bootstrap.reservation.version }),
        },
      );
      updateReservation(nextReservation);
      setRescheduleConfirmation(undefined);
      closeRescheduleReview();
    } catch (reason) {
      if (deferThrottledWrite(reason)) return;
      const failureMessage = t(
        "This booking could not be cancelled. Refresh the page and retry.",
      );
      const current = await verifyAppointmentAfterChange(bootstrap.reservation);
      if (!current) return;
      if (current.reservation.status === "cancelled") {
        setRescheduleConfirmation(undefined);
        closeRescheduleReview();
        return;
      }
      if (
        Date.parse(current.reservation.startsAt) !==
        Date.parse(bootstrap.reservation.startsAt)
      ) {
        closeRescheduleReview(appointmentMoved);
        return;
      }
      if (!current.canReschedule) {
        closeRescheduleReview(failureMessage);
        return;
      }
      setError(failureMessage);
    } finally {
      setBusy(false);
    }
  }

  async function reschedule() {
    if (
      !bootstrap?.canReschedule ||
      !selection ||
      Date.parse(selection.slot.startsAt) ===
        Date.parse(bootstrap.reservation.startsAt) ||
      busy ||
      needsVerification ||
      retryIsBlocked(writeLimit?.retryAt) ||
      !checkChangeDeadline()
    )
      return;
    const submittedStartsAt = selection.slot.startsAt;
    invalidateRefresh();
    setBusy(true);
    setWriteLimit(undefined);
    setError("");
    try {
      const nextReservation = await publicRequest<Reservation>(
        `${managePath}/reschedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: bootstrap.reservation.version,
            startsAt: submittedStartsAt,
          }),
        },
      );
      updateReservation(nextReservation);
      setRescheduling(false);
      setReviewing(false);
      setRescheduleConfirmation({
        startsAt: nextReservation.startsAt,
        displayTimeZone: selection.displayTimeZone,
      });
    } catch (requestError) {
      if (deferThrottledWrite(requestError)) return;
      const apiError = requestError as ApiError | undefined;
      const status = apiError?.status;
      const conflict = status === 404 || status === 409;
      const failureMessage = t(
        "This booking could not be rescheduled. Refresh the times and retry.",
      );
      if (status !== undefined && status < 500 && status !== 408 && !conflict) {
        setError(failureMessage);
        return;
      }

      const current = await verifyAppointmentAfterChange(bootstrap.reservation);
      if (!current) return;

      const currentStart = Date.parse(current.reservation.startsAt);
      const confirmed = current.reservation.status === "confirmed";
      if (confirmed && currentStart === Date.parse(submittedStartsAt)) {
        setRescheduleConfirmation({
          startsAt: current.reservation.startsAt,
          displayTimeZone: selection.displayTimeZone,
        });
        setRescheduling(false);
        setReviewing(false);
        return;
      }

      if (
        confirmed &&
        currentStart !== Date.parse(bootstrap.reservation.startsAt)
      ) {
        closeRescheduleReview(appointmentMoved);
        return;
      }

      const canContinueRescheduling =
        confirmed &&
        current.canReschedule &&
        currentStart - Date.now() >= current.cancellationMinutes * 60000;
      if (!canContinueRescheduling) {
        closeRescheduleReview(
          t("To change this appointment, contact the booking business."),
        );
        return;
      }

      if (!conflict) {
        setError(failureMessage);
        return;
      }

      setDisplayTimeZone(selection.displayTimeZone);
      setSelection(undefined);
      setReviewing(false);
      setAvailabilityRefreshKey((key) => key + 1);
      setError(
        t(
          apiError?.code === "BOOKING_TIME_CONFLICT"
            ? "That time conflicts with another meeting or appointment. Choose another available time."
            : "That time is no longer available. Choose another available time.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="mx-auto max-w-2xl px-4 py-10" role="status">
        {t("Loading booking settings…")}
      </main>
    );
  if (!bootstrap || !reservation)
    return (
      <main className="mx-auto grid max-w-2xl gap-3 px-4 py-10">
        <p role="alert" className="text-sm text-destructive">
          {canRetryLoad
            ? (readLimitMessage ?? t("Booking settings could not be loaded."))
            : t(
                "This booking link could not be loaded. Ask the booking owner for help.",
              )}
        </p>
        {canRetryLoad && (
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            disabled={readBlocked}
            onClick={() => {
              if (readIsBlocked()) return;
              setReadLimit(undefined);
              setLoading(true);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            {t("Retry")}
          </Button>
        )}
      </main>
    );

  const canChange =
    changeDeadline !== undefined &&
    changeDeadline !== closedDeadline &&
    Date.now() <= changeDeadline;
  const showRefresh =
    needsVerification ||
    (reservation.status === "confirmed" &&
      (refreshing ||
        refreshError ||
        readLimit !== undefined ||
        reservation.conference?.status === "pending"));
  const refreshMessage =
    (showRefresh && readLimitMessage) ||
    refreshError ||
    (needsVerification &&
      t(
        "We could not verify the change. Refresh the appointment before making another change.",
      ));
  const bookingCatalog = {
    id: reservation.id,
    timeZone: bootstrap.timeZone,
    horizonDays: bootstrap.horizonDays,
    leadMinutes: bootstrap.leadMinutes,
  };

  return (
    <main className="mx-auto grid max-w-3xl gap-5 px-4 py-8 md:py-12">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">
          {t("Manage or cancel this appointment")}
        </h1>
        <p>
          {reservation.serviceName} · {reservation.professionalName}
        </p>
        <p>
          {timeForZone(
            reservation.startsAt,
            bootstrap.timeZone,
            intlLocale(locale),
          )}{" "}
          · {bootstrap.timeZone}
        </p>
        <p>
          {reservation.customerName} · {reservation.customerEmail}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("Cancellation cutoff (minutes)")}: {bootstrap.cancellationMinutes}
        </p>
      </header>
      <p role="status" className="text-sm">
        {t(reservation.status === "confirmed" ? "Confirmed" : "Cancelled")}
      </p>
      <BookingConference
        conference={reservation.conference}
        status={reservation.status}
      />
      {showRefresh && (
        <Button
          type="button"
          variant="outline"
          disabled={refreshing || busy || readBlocked}
          onClick={() => void refreshAppointment()}
        >
          {refreshing ? t("Refreshing appointment…") : t("Refresh appointment")}
        </Button>
      )}
      {refreshMessage && (
        <p role="alert" className="text-sm text-destructive">
          {refreshMessage}
        </p>
      )}
      {rescheduleConfirmation &&
        summaryCatalog &&
        reservation.status === "confirmed" &&
        Date.parse(reservation.startsAt) ===
          Date.parse(rescheduleConfirmation.startsAt) && (
          <section className="grid gap-2" aria-live="polite">
            <h2 className="text-lg font-semibold">
              {t("Updated appointment")}
            </h2>
            <p role="status">{t("Your appointment has been updated.")}</p>
            <PublicBookingSummary
              catalog={summaryCatalog}
              selection={{
                serviceId: reservation.serviceId,
                professionalId: reservation.professionalId,
                displayTimeZone: rescheduleConfirmation.displayTimeZone,
                slot: {
                  startsAt: reservation.startsAt,
                  endsAt: reservation.endsAt,
                },
              }}
            />
          </section>
        )}
      {reservation.status === "confirmed" && (
        <div className="flex flex-wrap gap-2">
          {!rescheduling && bootstrap.canReschedule && canChange && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || needsVerification}
              onClick={() => {
                setSelection(undefined);
                setDisplayTimeZone(bootstrap.timeZone);
                setError("");
                setRescheduleConfirmation(undefined);
                setReviewing(false);
                setRescheduling(true);
              }}
            >
              {t("Reschedule")}
            </Button>
          )}
          <Button
            type="button"
            variant="destructive"
            disabled={busy || needsVerification || !canChange || writeBlocked}
            onClick={() => void cancel()}
          >
            {t("Cancel reservation")}
          </Button>
        </div>
      )}
      {reservation.status === "confirmed" && !canChange && (
        <p className="text-sm text-muted-foreground">
          {t("The cancellation and rescheduling window has closed.")}
        </p>
      )}
      {reservation.status === "confirmed" &&
        !bootstrap.canReschedule &&
        error !==
          t("To change this appointment, contact the booking business.") && (
          <p className="text-sm text-muted-foreground">
            {t("To change this appointment, contact the booking business.")}
          </p>
        )}
      {rescheduling && canChange && (
        <section className="grid gap-4" aria-live="polite">
          {!reviewing && (
            <>
              <h2
                id="booking-step-heading"
                ref={stepHeading}
                tabIndex={-1}
                className="text-lg font-semibold focus:outline-none"
              >
                {t("Choose a new time")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("Current appointment")}:{" "}
                {timeForZone(
                  reservation.startsAt,
                  displayTimeZone,
                  intlLocale(locale),
                )}
              </p>
              <PublicBookingAvailability
                token={token}
                mode="management"
                catalog={bookingCatalog}
                serviceId={reservation.serviceId}
                professionalId={reservation.professionalId}
                displayTimeZone={displayTimeZone}
                onTimeZoneChange={setDisplayTimeZone}
                value={selection}
                onChange={setSelection}
                onReadyChange={setSlotsReady}
                onAvailabilityUnavailable={() => void refreshAppointment()}
                readRetryAt={readRetryAt}
                onRateLimited={rememberReadDeadline}
                refreshKey={availabilityRefreshKey}
                hideHeading
                excludedStartAt={reservation.startsAt}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setRescheduling(false);
                    setSelection(undefined);
                    setError("");
                  }}
                >
                  {t("Stop rescheduling")}
                </Button>
                <Button
                  type="button"
                  disabled={
                    !selection ||
                    Date.parse(selection.slot.startsAt) ===
                      Date.parse(reservation.startsAt) ||
                    !slotsReady ||
                    busy
                  }
                  onClick={() => setReviewing(true)}
                >
                  {t("Continue")}
                </Button>
              </div>
            </>
          )}
          {reviewing && summaryCatalog && (
            <>
              <h2
                id="booking-step-heading"
                ref={stepHeading}
                tabIndex={-1}
                className="text-lg font-semibold focus:outline-none"
              >
                {t("Review your change")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("Current appointment")}:{" "}
                {timeForZone(
                  reservation.startsAt,
                  displayTimeZone,
                  intlLocale(locale),
                )}
              </p>
              <PublicBookingSummary
                catalog={summaryCatalog}
                selection={selection}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setReviewing(false)}
                >
                  {t("Back")}
                </Button>
                <Button
                  type="button"
                  disabled={busy || !selection || writeBlocked}
                  onClick={() => void reschedule()}
                >
                  {busy ? t("Saving…") : t("Confirm reschedule")}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
      {(writeLimitMessage || error) && (
        <p role="alert" className="text-sm text-destructive">
          {writeLimitMessage || error}
        </p>
      )}
      {bootstrap.publicUrl && (
        <a
          className="text-sm underline underline-offset-4"
          href={bootstrap.publicUrl}
        >
          {t("Book another appointment")}
        </a>
      )}
    </main>
  );
}
