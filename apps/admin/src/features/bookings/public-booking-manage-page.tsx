import { Button } from "@/components/ui/button";
import { useMessages, useAppLocale, intlLocale } from "@/i18n/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { bookingMessages } from "./booking-messages";
import { PublicBookingAvailability } from "./public-booking-availability";
import { PublicBookingSummary } from "./public-booking-summary";
import {
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
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(new Date(iso));
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [conferenceRefreshError, setConferenceRefreshError] = useState("");
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
    let active = true;
    void publicRequest<ManageBootstrap>(managePath)
      .then((data) => {
        if (active) {
          setBootstrap(data);
          setDisplayTimeZone(data.timeZone);
        }
      })
      .catch(() => {
        if (active) setBootstrap(undefined);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [managePath]);

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
      if (!current) return next;
      if (
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

  async function refreshAppointment() {
    if (!bootstrap) return;
    const previous = bootstrap.reservation;
    const request = ++refreshSequence.current;
    setRefreshing(true);
    setConferenceRefreshError("");
    try {
      const data = await publicRequest<ManageBootstrap>(managePath);
      if (
        request !== refreshSequence.current ||
        data.reservation.id !== previous.id ||
        data.reservation.version < previous.version
      )
        return;
      updateBootstrap(data);

      const moved =
        data.reservation.status === "confirmed" &&
        Date.parse(data.reservation.startsAt) !== Date.parse(previous.startsAt);
      if (
        moved ||
        !data.canReschedule ||
        data.reservation.status !== "confirmed"
      )
        closeRescheduleReview(moved ? appointmentMoved : "");
    } catch {
      if (request === refreshSequence.current)
        setConferenceRefreshError(
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

  async function cancel() {
    if (!bootstrap || busy || !checkChangeDeadline()) return;
    invalidateRefresh();
    setBusy(true);
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
    } catch {
      const failureMessage = t(
        "This booking could not be cancelled. Refresh the page and retry.",
      );
      const current = await publicRequest<ManageBootstrap>(managePath).catch(
        () => undefined,
      );
      if (
        current?.reservation?.id === bootstrap.reservation.id &&
        current.reservation.version >= bootstrap.reservation.version
      ) {
        updateBootstrap(current);
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
      !checkChangeDeadline()
    )
      return;
    const submittedStartsAt = selection.slot.startsAt;
    invalidateRefresh();
    setBusy(true);
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
      const apiError = requestError as ApiError | undefined;
      const status = apiError?.status;
      const conflict = status === 404 || status === 409;
      const failureMessage = t(
        "This booking could not be rescheduled. Refresh the times and retry.",
      );
      if (status !== undefined && status < 500 && !conflict) {
        setError(failureMessage);
        return;
      }

      const current = await publicRequest<ManageBootstrap>(managePath).catch(
        () => undefined,
      );
      if (
        current?.reservation?.id !== bootstrap.reservation.id ||
        current.reservation.version < bootstrap.reservation.version
      ) {
        setError(failureMessage);
        return;
      }
      updateBootstrap(current);

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
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p role="alert" className="text-sm text-destructive">
          {t(
            "This booking link could not be loaded. Ask the booking owner for help.",
          )}
        </p>
      </main>
    );

  const canChange =
    changeDeadline !== undefined &&
    changeDeadline !== closedDeadline &&
    Date.now() <= changeDeadline;
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
      {reservation.status === "confirmed" &&
        reservation.conference?.status === "pending" && (
          <Button
            type="button"
            variant="outline"
            disabled={refreshing || busy}
            onClick={() => void refreshAppointment()}
          >
            {refreshing
              ? t("Refreshing appointment…")
              : t("Refresh appointment")}
          </Button>
        )}
      {conferenceRefreshError && (
        <p role="alert" className="text-sm text-destructive">
          {conferenceRefreshError}
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
              disabled={busy}
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
            disabled={busy || !canChange}
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
                  disabled={busy || !selection}
                  onClick={() => void reschedule()}
                >
                  {busy ? t("Saving…") : t("Confirm reschedule")}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
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
