import { RouteLoading } from "@/components/admin/route-loading";
import type { AppServices } from "@/app-services";
import { ApiClientError } from "@/api/api-client";
import type { paths } from "@/api/generated/openapi";
import { Button } from "@/components/ui/button";
import { ResponsiveActionButton } from "@/components/ui/responsive-action-button";
import { Plus, RefreshCw, Save, Trash2, Unplug, XCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAppLocale, useMessages } from "@/i18n/core";
import { TenantScopeBoundary } from "@/features/tenants/tenant-scope-boundary";
import { isReadAuthenticationRequired as isAuthenticationRequired } from "@/queries/read-state";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  bookingTabs,
  readBookingRouteQuery,
  type BookingTab,
} from "@savia/tenant-host/bookings-route";
import { bookingMessages } from "./booking-messages";
import { bookingOrganizationPickerHref } from "./booking-organization-link";
import { BookingSignInRecovery } from "./booking-sign-in-recovery";
import { bookingDayRange } from "./booking-date";
import { bookingSetupMessages } from "./booking-setup-messages";
import { validAvailabilityPeriods, validWeeklyHours } from "./booking-schedule";

import type {
  Period,
  Exception,
  Professional,
  Settings,
} from "./booking-types";
import { BookingSetupWizard, WeeklyHoursEditor } from "./booking-setup-wizard";
import { BookingPublicLinksPanel } from "./booking-public-links-panel";
import {
  BookingConference,
  type BookingConferenceState,
} from "./booking-conference";
type Bootstrap = {
  settings: Settings;
  candidates: Array<{ principalId: string; displayName: string }>;
  canManage: boolean;
  principalId: string;
  publicUrl: string | null;
  calendar: {
    provider: null | "google_calendar" | "outlook";
    status: string;
    conferenceProvider?: "auto" | "zoom";
    zoomStatus?: "connected" | "not_connected" | "reconnect_required";
  };
  agenda?: { enabled: boolean; sourceCount: number };
};
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
  calendarProvider?: "google_calendar" | "outlook" | null;
  calendarEventIdPresent?: boolean;
  canGenerateConference?: boolean;
  availableConferenceProviders?: Array<"auto" | "zoom">;
  conference?: BookingConferenceState;
};
type ReservationsResponse =
  paths["/v1/tenants/{tenantId}/booking/reservations"]["get"]["responses"][200]["content"]["application/json"];
type ReservationAction = "cancel" | "conference";
type ReservationActionFeedback = {
  pending?: ReservationAction;
  error?: string;
};

type AvailabilityDraft = {
  baseline: Professional;
  weekly: Period[];
  exceptions: Exception[];
  exceptionDate: string;
};

function periodSignature(periods?: Exception["periods"]) {
  return (
    periods &&
    JSON.stringify(periods.map(({ start, end }) => [start, end]).sort())
  );
}

function mergeWeeklyHours(
  draft: Period[],
  previous: Period[],
  saved: Period[],
) {
  const days = new Set([...saved, ...draft].map(({ day }) => day));
  return [...days].flatMap((day) => {
    const local = draft.filter((period) => period.day === day);
    const original = previous.filter((period) => period.day === day);
    return periodSignature(local) === periodSignature(original)
      ? saved.filter((period) => period.day === day)
      : local;
  });
}

function mergeExceptions(
  draft: Exception[],
  previous: Exception[],
  saved: Exception[],
) {
  const localByDate = new Map(draft.map((item) => [item.date, item]));
  const previousByDate = new Map(previous.map((item) => [item.date, item]));
  const savedByDate = new Map(saved.map((item) => [item.date, item]));
  const dates = new Set([...savedByDate.keys(), ...localByDate.keys()]);
  return [...dates].sort().flatMap((date) => {
    const local = localByDate.get(date);
    const original = previousByDate.get(date);
    const exception =
      periodSignature(local?.periods) === periodSignature(original?.periods)
        ? savedByDate.get(date)
        : local;
    return exception ? [exception] : [];
  });
}

function readAvailabilityDraft(
  professional: Professional,
  draft?: AvailabilityDraft,
): AvailabilityDraft {
  if (!draft || draft.baseline.principalId !== professional.principalId) {
    return {
      baseline: professional,
      weekly: professional.weekly,
      exceptions: professional.exceptions,
      exceptionDate: "",
    };
  }
  if (draft.baseline === professional) return draft;
  return {
    ...draft,
    baseline: professional,
    weekly: mergeWeeklyHours(
      draft.weekly,
      draft.baseline.weekly,
      professional.weekly,
    ),
    exceptions: mergeExceptions(
      draft.exceptions,
      draft.baseline.exceptions,
      professional.exceptions,
    ),
  };
}

function isConflict(error: unknown) {
  return error instanceof ApiClientError
    ? error.status === 409 || error.code === "VERSION_CONFLICT"
    : Boolean(
        error &&
        typeof error === "object" &&
        (("status" in error && error.status === 409) ||
          ("code" in error && error.code === "VERSION_CONFLICT")),
      );
}

function displayTime(iso: string, zone: string, locale: string) {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: zone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

type BookingPageProps = {
  services: Pick<AppServices, "apiClient">;
  tenantId: number;
  hostname?: string;
};
type BookingAccessProblem = "sign-in" | "organization";

export function BookingPage(props: BookingPageProps) {
  return <BookingWorkspaceAccess key={props.tenantId} {...props} />;
}

function BookingWorkspaceAccess({
  hostname = window.location.hostname,
  ...props
}: BookingPageProps) {
  const { search } = useLocation();
  const [accessProblem, setAccessProblem] = useState<BookingAccessProblem>();
  if (accessProblem === "sign-in")
    return <BookingSignInRecovery className="p-6" />;
  if (accessProblem === "organization")
    return (
      <TenantScopeBoundary
        status="error"
        retry={() => setAccessProblem(undefined)}
        organizationPickerHref={bookingOrganizationPickerHref(hostname, search)}
      >
        {null}
      </TenantScopeBoundary>
    );
  return <BookingWorkspace {...props} onAccessProblem={setAccessProblem} />;
}

function bookingReadProblem(error: unknown): BookingAccessProblem | undefined {
  if (isAuthenticationRequired(error)) return "sign-in";
  if (
    error instanceof ApiClientError &&
    (error.status === 403 || error.status === 404)
  )
    return "organization";
}

function BookingWorkspace({
  services,
  tenantId,
  onAccessProblem,
}: Pick<BookingPageProps, "services" | "tenantId"> & {
  onAccessProblem: (problem: BookingAccessProblem) => void;
}) {
  const t = useMessages(bookingMessages);
  const setupText = useMessages(bookingSetupMessages);
  const locale = useAppLocale();
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [loading, setLoading] = useState(true);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const { tab = "settings", date: appointmentDate } =
    readBookingRouteQuery(searchParams);
  const [settings, setSettings] = useState<Settings>();
  const [availabilityDrafts, setAvailabilityDrafts] = useState(
    () => new Map<string, AvailabilityDraft>(),
  );
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [reservationReadPending, setReservationsLoading] = useState(false);
  const [requestedReservationRange, setRequestedReservationRange] =
    useState<string>();
  const [reservationsLoadFailed, setReservationsLoadFailed] = useState(false);
  const [reservationActions, setReservationActions] = useState<
    Record<string, ReservationActionFeedback>
  >({});
  const pendingReservationActions = useRef(new Set<string>());
  const [reservationsAttempt, setReservationsAttempt] = useState(0);
  const [nextReservationPage, setNextReservationPage] = useState<{
    url: string;
    cursor: string;
  }>();
  const [loadingMoreReservations, setLoadingMoreReservations] = useState(false);
  const [moreReservationsFailed, setMoreReservationsFailed] = useState(false);
  const moreReservationsRequest = useRef<AbortController | null>(null);
  const updatesDuringReservationRead = useRef<Map<string, Reservation> | null>(
    null,
  );
  const [conferenceSelections, setConferenceSelections] = useState<
    Record<string, "auto" | "zoom">
  >({});
  const ready = !!bootstrap;
  const tZone = bootstrap?.settings.timeZone ?? "UTC";
  const horizonDays = bootstrap?.settings.horizonDays ?? 30;
  const reservationRange = JSON.stringify([
    appointmentDate,
    tZone,
    horizonDays,
  ]);
  const reservationsLoading =
    reservationReadPending || requestedReservationRange !== reservationRange;
  const currentProfessional = useMemo(
    () =>
      bootstrap?.settings.professionals.find(
        (item) => item.principalId === bootstrap.principalId,
      ),
    [bootstrap],
  );
  const linkProfessional = useMemo(
    () =>
      bootstrap?.settings.professionals.find(
        (item) =>
          item.principalId === bootstrap.principalId &&
          item.enabled &&
          bootstrap.settings.enabled &&
          bootstrap.settings.published &&
          bootstrap.candidates.some(
            (candidate) => candidate.principalId === item.principalId,
          ) &&
          bootstrap.settings.services.some(
            (service) =>
              service.enabled && service.professionalIds.includes(item.id),
          ),
      ),
    [bootstrap],
  );

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    setBootstrapFailed(false);
    setError("");
    setNotice("");
    setBootstrap(undefined);
    setSettings(undefined);
    setReservations([]);
    setConferenceSelections({});
    void services.apiClient
      .get<{ data: Bootstrap }>(`/v1/tenants/${tenantId}/booking`, { signal })
      .then(({ data }) => {
        if (signal.aborted) return;
        setBootstrap(data);
        setSettings(data.settings);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        const problem = bookingReadProblem(error);
        if (problem) onAccessProblem(problem);
        else setBootstrapFailed(true);
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, services.apiClient, attempt, onAccessProblem]);

  const readReservationPage = useCallback(
    async (
      url: string,
      onPage: (page: ReservationsResponse) => void,
      signal: AbortSignal,
    ) => {
      const updates = new Map<string, Reservation>();
      updatesDuringReservationRead.current = updates;
      try {
        const page = await services.apiClient.get<ReservationsResponse>(url, {
          signal,
        });
        if (signal.aborted) return;
        onPage({
          ...page,
          data: page.data.map((reservation) => {
            const updated = updates.get(reservation.id);
            // The conference status can change within the same reservation version.
            return updated && updated.version >= reservation.version
              ? updated
              : reservation;
          }),
        });
      } catch (error) {
        const problem = bookingReadProblem(error);
        if (signal.aborted || !problem) throw error;
        onAccessProblem(problem);
      } finally {
        if (updatesDuringReservationRead.current === updates)
          updatesDuringReservationRead.current = null;
      }
    },
    [services.apiClient, onAccessProblem],
  );

  useEffect(() => {
    if (tab !== "reservations" || !ready) return;
    const controller = new AbortController();
    const { signal } = controller;
    setRequestedReservationRange(reservationRange);
    setReservationsLoading(true);
    setReservationsLoadFailed(false);
    setReservationActions((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, feedback]) => feedback.pending),
      ),
    );
    setNextReservationPage(undefined);
    setLoadingMoreReservations(false);
    setMoreReservationsFailed(false);
    setError("");
    const now = new Date();
    const { from, to } = appointmentDate
      ? bookingDayRange(appointmentDate, tZone)
      : {
          from: now,
          to: new Date(
            now.getTime() + Math.min(90, Math.max(1, horizonDays)) * 86400000,
          ),
        };
    if (from >= to) {
      setReservations([]);
      setReservationsLoading(false);
      return;
    }
    const url = `/v1/tenants/${tenantId}/booking/reservations?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
    void readReservationPage(
      url,
      ({ data, nextCursor }) => {
        setReservations(data);
        setNextReservationPage(
          nextCursor ? { url, cursor: nextCursor } : undefined,
        );
      },
      signal,
    )
      .catch(() => {
        if (!signal.aborted) setReservationsLoadFailed(true);
      })
      .finally(() => {
        if (!signal.aborted) setReservationsLoading(false);
      });
    return () => {
      controller.abort();
      moreReservationsRequest.current?.abort();
      moreReservationsRequest.current = null;
    };
  }, [
    tab,
    ready,
    tenantId,
    readReservationPage,
    reservationsAttempt,
    reservationRange,
    horizonDays,
    appointmentDate,
    tZone,
  ]);

  async function loadMoreReservations() {
    if (!nextReservationPage || moreReservationsRequest.current) return;
    const { url, cursor } = nextReservationPage;
    const controller = new AbortController();
    moreReservationsRequest.current = controller;
    setLoadingMoreReservations(true);
    setMoreReservationsFailed(false);
    try {
      await readReservationPage(
        `${url}&cursor=${encodeURIComponent(cursor)}`,
        ({ data, nextCursor }) => {
          setReservations((current) => {
            const byId = new Map(current.map((item) => [item.id, item]));
            for (const item of data) {
              const previous = byId.get(item.id);
              if (!previous || item.version > previous.version)
                byId.set(item.id, item);
            }
            return [...byId.values()];
          });
          setNextReservationPage(
            nextCursor ? { url, cursor: nextCursor } : undefined,
          );
        },
        controller.signal,
      );
    } catch {
      if (!controller.signal.aborted) setMoreReservationsFailed(true);
    } finally {
      if (!controller.signal.aborted) {
        moreReservationsRequest.current = null;
        setLoadingMoreReservations(false);
      }
    }
  }

  function openTab(next: BookingTab) {
    setError("");
    setNotice("");
    if (next === tab) return;
    setSearchParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === "settings") updated.delete("tab");
      else updated.set("tab", next);
      return updated;
    });
  }

  function saveErrorMessage(error: unknown, kind: "settings" | "availability") {
    if (isConflict(error)) {
      return t(
        "Booking settings changed elsewhere. Reload before saving again.",
      );
    }
    if (error instanceof ApiClientError) {
      const message = Object.prototype.hasOwnProperty.call(
        bookingMessages,
        error.message,
      )
        ? t(error.message as keyof typeof bookingMessages)
        : error.message;
      return t(
        kind === "settings"
          ? "Booking settings could not be saved (HTTP %{status}): %{message}"
          : "Availability could not be saved (HTTP %{status}). %{message}",
        { status: error.status, message },
      );
    }
    return t(
      kind === "settings"
        ? "Booking settings could not be saved. Check your connection and retry."
        : "Availability could not be saved. Check your connection and retry.",
    );
  }

  const recoverExpiredSession = useCallback(
    (error: unknown): boolean => {
      if (!isAuthenticationRequired(error)) return false;
      onAccessProblem("sign-in");
      return true;
    },
    [onAccessProblem],
  );

  async function saveSettings(settings: Settings) {
    if (
      settings.published &&
      (!settings.enabled ||
        !settings.services.some(
          (service) =>
            service.enabled &&
            service.professionalIds.some((id) =>
              settings.professionals.some(
                (professional) =>
                  professional.id === id && professional.enabled,
              ),
            ),
        ))
    ) {
      setNotice("");
      setError(
        t("Enable a service and an assigned professional before publishing."),
      );
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await services.apiClient.put<{ data: Bootstrap }>(
        `/v1/tenants/${tenantId}/booking`,
        settings,
      );
      const next = result.data;
      setBootstrap(next);
      setSettings(next.settings);
      setNotice(t("Booking settings saved."));
    } catch (exception) {
      if (recoverExpiredSession(exception)) return;
      setError(saveErrorMessage(exception, "settings"));
    } finally {
      setSaving(false);
    }
  }

  async function saveAvailability(event: FormEvent) {
    event.preventDefault();
    if (saving || !bootstrap || !scheduleProfessional) return;
    setNotice("");
    if (!validWeeklyHours(weekly)) {
      setError(
        setupText(
          "Check weekly hours. Use five-minute increments and non-overlapping periods.",
        ),
      );
      return;
    }
    if (exceptions.length > 200) {
      setError(t("Use up to 200 exception dates."));
      return;
    }
    const invalidException = exceptions.find(
      ({ periods }) => periods.length > 4 || !validAvailabilityPeriods(periods),
    );
    if (invalidException) {
      setError(
        t(
          "Check the exception for %{date}. Use up to four non-overlapping periods in five-minute increments, with each end after its start.",
          { date: invalidException.date },
        ),
      );
      return;
    }
    const saved = bootstrap.settings;
    const target = scheduleProfessional;
    setSaving(true);
    setError("");
    try {
      const result = bootstrap.canManage
        ? await services.apiClient.put<{ data: Bootstrap }>(
            `/v1/tenants/${tenantId}/booking`,
            {
              ...saved,
              professionals: saved.professionals.map((professional) =>
                professional.id === target.id
                  ? { ...professional, weekly, exceptions }
                  : professional,
              ),
            },
          )
        : await services.apiClient.put<{ data: Bootstrap }>(
            `/v1/tenants/${tenantId}/booking/availability`,
            { weekly, exceptions, version: saved.version },
          );
      const next = result.data;
      const savedSchedule = next.settings.professionals.find(
        (professional) => professional.id === target.id,
      );
      setBootstrap(next);
      setAvailabilityDrafts((drafts) => {
        const draft = drafts.get(target.id);
        if (!draft) return drafts;
        const updated = new Map(drafts);
        if (savedSchedule && draft.exceptionDate) {
          updated.set(target.id, {
            ...readAvailabilityDraft(savedSchedule),
            exceptionDate: draft.exceptionDate,
          });
        } else {
          updated.delete(target.id);
        }
        return updated;
      });
      setSettings((draft) => {
        if (!draft || draft === saved) return next.settings;
        if (draft.version !== saved.version) return draft;
        return {
          ...draft,
          version: next.settings.version,
          professionals: draft.professionals.map((professional) =>
            professional.id === target.id && savedSchedule
              ? {
                  ...professional,
                  weekly: mergeWeeklyHours(
                    professional.weekly,
                    target.weekly,
                    savedSchedule.weekly,
                  ),
                  exceptions: savedSchedule.exceptions,
                }
              : professional,
          ),
        };
      });
      setNotice(t("Availability saved."));
    } catch (exception) {
      if (recoverExpiredSession(exception)) return;
      setError(saveErrorMessage(exception, "availability"));
    } finally {
      setSaving(false);
    }
  }

  const [selectedProfessional, setSelectedProfessional] = useState("");
  useEffect(() => {
    if (!bootstrap) return;
    const { professionals } = bootstrap.settings;
    setSelectedProfessional((current) => {
      if (professionals.some((item) => item.id === current)) return current;
      const owned = professionals.find(
        (item) => item.principalId === bootstrap.principalId,
      );
      return owned?.id ?? professionals[0]?.id ?? "";
    });
  }, [bootstrap]);
  const scheduleProfessional = bootstrap?.canManage
    ? bootstrap.settings.professionals.find(
        (item) => item.id === selectedProfessional,
      )
    : currentProfessional;
  const availability = scheduleProfessional
    ? readAvailabilityDraft(
        scheduleProfessional,
        availabilityDrafts.get(scheduleProfessional.id),
      )
    : undefined;
  const {
    weekly = [],
    exceptions = [],
    exceptionDate = "",
  } = availability ?? {};

  function updateAvailability(
    update: (draft: AvailabilityDraft) => AvailabilityDraft,
  ) {
    if (!scheduleProfessional) return;
    setAvailabilityDrafts((drafts) => {
      const id = scheduleProfessional.id;
      const updated = new Map(drafts);
      updated.set(
        id,
        update(readAvailabilityDraft(scheduleProfessional, drafts.get(id))),
      );
      return updated;
    });
  }

  function setExceptions(update: (items: Exception[]) => Exception[]) {
    updateAvailability((draft) => ({
      ...draft,
      exceptions: update(draft.exceptions),
    }));
  }

  function editExceptionPeriod(
    date: string,
    index: number,
    field: "start" | "end",
    value: string,
  ) {
    setExceptions((current) =>
      current.map((exception) => {
        if (exception.date !== date) return exception;
        const period = exception.periods.at(index);
        if (!period && !value) return exception;
        const periods = [...exception.periods];
        periods[index] = {
          ...(period ?? { start: "09:00", end: "17:00" }),
          [field]: value,
        };
        return { ...exception, periods };
      }),
    );
  }

  function addExceptionPeriod(date: string) {
    setExceptions((current) =>
      current.map((exception) =>
        exception.date === date && exception.periods.length < 4
          ? {
              ...exception,
              periods: [...exception.periods, { start: "09:00", end: "17:00" }],
            }
          : exception,
      ),
    );
  }

  function applyConnectionResult(previous: Bootstrap, next: Bootstrap) {
    const sameEditor =
      previous.canManage === next.canManage &&
      previous.principalId === next.principalId;
    // An unchanged version still has the same saved professional schedules.
    // Keep their references so a connection response does not reset the editor.
    const savedSettings =
      sameEditor && previous.settings.version === next.settings.version
        ? { ...next.settings, professionals: previous.settings.professionals }
        : next.settings;
    setBootstrap({ ...next, settings: savedSettings });
    setSettings((draft) =>
      draft && draft !== previous.settings && sameEditor
        ? draft
        : savedSettings,
    );
  }

  async function changeCalendar(
    provider: null | "google_calendar" | "outlook",
    conferenceProvider?: "auto" | "zoom",
  ) {
    if (!bootstrap) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await services.apiClient.put<{ data: Bootstrap }>(
        `/v1/tenants/${tenantId}/booking/calendar`,
        { provider, ...(conferenceProvider ? { conferenceProvider } : {}) },
      );
      applyConnectionResult(bootstrap, result.data);
      setNotice(t("Availability saved."));
    } catch (exception) {
      if (recoverExpiredSession(exception)) return;
      setError(t("Availability could not be saved. Reload and retry."));
    } finally {
      setSaving(false);
    }
  }

  async function changeMyDayAccess(enabled: boolean) {
    if (!bootstrap) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await services.apiClient.put<{ data: Bootstrap }>(
        `/v1/tenants/${tenantId}/booking/agenda`,
        { enabled },
      );
      applyConnectionResult(bootstrap, result.data);
      setNotice(
        t(
          enabled
            ? "My Day availability access updated."
            : "My Day availability access stopped.",
        ),
      );
    } catch (exception) {
      if (recoverExpiredSession(exception)) return;
      setError(
        t(
          "My Day availability could not be updated. Check your connection and retry.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function cancelReservation(reservation: Reservation) {
    if (pendingReservationActions.current.has(reservation.id)) return;
    const provider = reservation.calendarProvider
      ? calendarProviderName(reservation.calendarProvider)
      : null;
    if (
      !window.confirm(
        t(
          provider
            ? "Confirm reservation cancellation with calendar"
            : "Confirm reservation cancellation without calendar",
          provider ? { calendar: provider } : undefined,
        ),
      )
    )
      return;
    await runReservationAction(reservation, "cancel");
  }

  function calendarProviderName(provider: "google_calendar" | "outlook") {
    return provider === "google_calendar" ? "Google Calendar" : "Outlook";
  }

  function calendarStatusLabel(reservation: Reservation) {
    const provider = reservation.calendarProvider;
    if (!provider || reservation.calendarStatus === "not_requested")
      return t("Not requested");
    const calendar = calendarProviderName(provider);
    if (reservation.status === "cancelled") {
      if (reservation.calendarStatus === "pending")
        return t("Calendar cancellation pending for %{calendar}", {
          calendar,
        });
      if (reservation.calendarStatus === "failed")
        return t("Could not cancel in %{calendar}", { calendar });
      if (reservation.calendarStatus === "completed")
        return reservation.calendarEventIdPresent
          ? t("Cancelled in %{calendar}", { calendar })
          : t("Calendar cancellation processed for %{calendar}", {
              calendar,
            });
    }
    if (
      reservation.calendarStatus === "pending" &&
      reservation.calendarEventIdPresent
    )
      return t("Event saved in %{calendar}; synchronization pending", {
        calendar,
      });
    if (reservation.calendarStatus === "pending")
      return t("Saving to %{calendar}…", { calendar });
    if (
      reservation.calendarStatus === "failed" &&
      reservation.calendarEventIdPresent
    )
      return t("Event saved in %{calendar}; synchronization failed", {
        calendar,
      });
    if (reservation.calendarStatus === "failed")
      return t("Could not save to %{calendar}", { calendar });
    if (reservation.calendarStatus === "completed")
      return reservation.calendarEventIdPresent
        ? t("Saved in %{calendar}", { calendar })
        : t("No event saved to %{calendar}", { calendar });
    if (reservation.calendarStatus === "skipped")
      return t("Calendar sync skipped for %{calendar}", { calendar });
    return reservation.calendarStatus;
  }

  function selectedConferenceProvider(
    reservation: Reservation,
  ): "auto" | "zoom" | undefined {
    return (
      conferenceSelections[reservation.id] ??
      (reservation.availableConferenceProviders?.includes("zoom") &&
      (reservation.conference?.status === "unsupported" ||
        reservation.conference?.provider === "zoom" ||
        !reservation.availableConferenceProviders.includes("auto"))
        ? "zoom"
        : undefined)
    );
  }

  async function runReservationAction(
    reservation: Reservation,
    action: ReservationAction,
  ) {
    const { id, version } = reservation;
    if (pendingReservationActions.current.has(id)) return;
    pendingReservationActions.current.add(id);
    setReservationActions((current) => ({
      ...current,
      [id]: { pending: action },
    }));
    setNotice("");
    try {
      const provider =
        action === "conference"
          ? selectedConferenceProvider(reservation)
          : undefined;
      const result = await services.apiClient.post<{ data: Reservation }>(
        `/v1/tenants/${tenantId}/booking/reservations/${encodeURIComponent(id)}/${action}`,
        { version, ...(provider ? { provider } : {}) },
      );
      updatesDuringReservationRead.current?.set(id, result.data);
      setReservations((current) =>
        current.map((item) =>
          item.id === id && item.version <= result.data.version
            ? result.data
            : item,
        ),
      );
      setNotice(
        action === "cancel"
          ? t("Reservation cancelled.")
          : t("Video meeting link is being prepared. Refresh to check again."),
      );
      setReservationActions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch (exception) {
      if (recoverExpiredSession(exception)) return;
      const error =
        action === "cancel"
          ? t("Reservation could not be cancelled. Refresh and retry.")
          : t(
              "Video meeting link request failed. Check the calendar connection and retry.",
            );
      setReservationActions((current) => ({ ...current, [id]: { error } }));
    } finally {
      pendingReservationActions.current.delete(id);
    }
  }

  if (!ready)
    return (
      <main
        className="mx-auto grid max-w-5xl gap-5 px-4 py-8 md:px-6"
        aria-busy={loading}
      >
        {bootstrapFailed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("Booking settings could not be loaded.")}
          </p>
        ) : (
          <RouteLoading label={t("Loading booking settings…")} />
        )}
        {bootstrapFailed && (
          <ResponsiveActionButton
            icon={RefreshCw}
            type="button"
            variant="outline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("Retry")}
          </ResponsiveActionButton>
        )}
      </main>
    );

  const publicReady =
    bootstrap.settings.enabled && bootstrap.settings.published;
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 md:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {settings?.title || t("Appointments")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Manage appointments and your availability.")}
          </p>
        </div>
        {publicReady && bootstrap.publicUrl && bootstrap.canManage && (
          <a
            className="text-sm font-medium underline underline-offset-4"
            href={bootstrap.publicUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("Open team booking page")}
          </a>
        )}
      </header>

      <nav
        aria-label={t("Booking settings")}
        className="grid grid-cols-2 gap-1 border-b pb-2 sm:flex sm:flex-wrap sm:gap-2"
      >
        {bookingTabs.map((value) => (
          <Button
            key={value}
            type="button"
            className="min-h-11 h-auto min-w-0 whitespace-normal px-2 py-3 sm:px-4"
            variant={tab === value ? "secondary" : "ghost"}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => openTab(value)}
          >
            {t(
              value === "settings"
                ? "Booking settings"
                : value === "availability"
                  ? "Availability"
                  : value === "reservations"
                    ? "Reservations"
                    : "Booking links",
            )}
          </Button>
        ))}
      </nav>

      {notice && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {tab === "settings" && bootstrap.canManage && settings && (
        <BookingSetupWizard
          key={tenantId}
          settings={settings}
          candidates={bootstrap.candidates ?? []}
          onChange={setSettings}
          onSave={saveSettings}
          onReset={() => setSettings(bootstrap.settings)}
          saving={saving}
          publicUrl={publicReady ? bootstrap.publicUrl : null}
        />
      )}

      {tab === "settings" && bootstrap.canManage && !publicReady && (
        <p className="text-sm text-muted-foreground">
          {t("Save enabled and published settings to open the public page.")}
        </p>
      )}

      {tab === "settings" && !bootstrap.canManage && (
        <section className="grid max-w-2xl gap-2">
          <h2 className="text-lg font-semibold">{t("Your availability")}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "Edit weekly hours and date-specific exceptions. Times use %{timeZone}.",
              { timeZone: tZone },
            )}
          </p>
          <Button type="button" onClick={() => openTab("availability")}>
            {t("Availability")}
          </Button>
        </section>
      )}

      {tab === "sharing" && settings && (
        <BookingPublicLinksPanel
          tenantId={String(tenantId)}
          currentProfessionalId={linkProfessional?.id ?? null}
          currentProfessionalName={
            bootstrap.candidates.find(
              (candidate) =>
                candidate.principalId === linkProfessional?.principalId,
            )?.displayName
          }
          canManageTeamLinks={bootstrap.canManage}
          apiClient={services.apiClient}
          recoverExpiredSession={recoverExpiredSession}
          services={settings.services
            .filter((service) => service.enabled)
            .map(({ id, name }) => ({ id, name }))}
        />
      )}

      {tab === "availability" && (
        <section className="grid max-w-4xl gap-5">
          <div>
            <h2 className="text-lg font-semibold">{t("Your availability")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                "Edit weekly hours and date-specific exceptions. Times use %{timeZone}.",
                { timeZone: tZone },
              )}
            </p>
          </div>
          {bootstrap.canManage && (
            <label className="grid max-w-md gap-1.5 text-sm">
              {t("Professional")}
              <select
                className="h-9 min-w-0 max-w-full rounded-md border bg-background px-3 max-sm:h-11"
                value={selectedProfessional}
                disabled={saving}
                onChange={(event) => {
                  setSelectedProfessional(event.target.value);
                  setError("");
                  setNotice("");
                }}
              >
                {bootstrap.settings.professionals.map((professional) => (
                  <option key={professional.id} value={professional.id}>
                    {bootstrap.candidates.find(
                      (candidate) =>
                        candidate.principalId === professional.principalId,
                    )?.displayName ?? professional.principalId}
                  </option>
                ))}
              </select>
            </label>
          )}
          {scheduleProfessional ? (
            <form className="grid gap-5" onSubmit={saveAvailability} noValidate>
              <WeeklyHoursEditor
                value={weekly}
                onChange={(weekly) =>
                  updateAvailability((draft) => ({ ...draft, weekly }))
                }
                disabled={saving}
              />
              <fieldset disabled={saving} className="grid gap-3">
                <legend className="text-base font-semibold">
                  {t("Exceptions")}
                </legend>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid gap-1.5 text-sm">
                    {t("Exception date")}
                    <Input
                      type="date"
                      value={exceptionDate}
                      onChange={(event) => {
                        const exceptionDate = event.target.value;
                        updateAvailability((draft) => ({
                          ...draft,
                          exceptionDate,
                        }));
                      }}
                    />
                  </label>
                  <ResponsiveActionButton
                    icon={Plus}
                    type="button"
                    variant="outline"
                    disabled={
                      !exceptionDate ||
                      exceptions.some((item) => item.date === exceptionDate)
                    }
                    onClick={() =>
                      updateAvailability((draft) => ({
                        ...draft,
                        exceptionDate: "",
                        exceptions: [
                          ...draft.exceptions,
                          { date: draft.exceptionDate, periods: [] },
                        ].sort((a, b) => a.date.localeCompare(b.date)),
                      }))
                    }
                  >
                    {t("Add exception")}
                  </ResponsiveActionButton>
                </div>
                {exceptions.map((exception) => (
                  <div
                    key={exception.date}
                    className="grid gap-3 rounded-lg border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong>{exception.date}</strong>
                      <div className="flex gap-2">
                        <ResponsiveActionButton
                          icon={Plus}
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={exception.periods.length >= 4}
                          onClick={() => addExceptionPeriod(exception.date)}
                        >
                          {t("Add period")}
                        </ResponsiveActionButton>
                        <ResponsiveActionButton
                          icon={Trash2}
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setExceptions((items) =>
                              items.filter(
                                (item) => item.date !== exception.date,
                              ),
                            )
                          }
                        >
                          {t("Remove exception")}
                        </ResponsiveActionButton>
                      </div>
                    </div>
                    {(exception.periods.length
                      ? exception.periods
                      : [{ start: "", end: "" }]
                    ).map((period, index) => (
                      <div
                        key={`${exception.date}-${index}`}
                        className="grid gap-2 sm:grid-cols-3"
                      >
                        <label className="grid gap-1 text-sm">
                          {t("Start")}
                          <Input
                            aria-label={`${exception.date} ${t("Start")} ${index + 1}`}
                            type="time"
                            step={300}
                            value={period.start}
                            onChange={(event) =>
                              editExceptionPeriod(
                                exception.date,
                                index,
                                "start",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                        <label className="grid gap-1 text-sm">
                          {t("End")}
                          <Input
                            aria-label={`${exception.date} ${t("End")} ${index + 1}`}
                            type="time"
                            step={300}
                            value={period.end}
                            onChange={(event) =>
                              editExceptionPeriod(
                                exception.date,
                                index,
                                "end",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                        {exception.periods.length > 0 && (
                          <ResponsiveActionButton
                            icon={Trash2}
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setExceptions((items) =>
                                items.map((item) =>
                                  item.date === exception.date
                                    ? {
                                        ...item,
                                        periods: item.periods.filter(
                                          (_, periodIndex) =>
                                            periodIndex !== index,
                                        ),
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            {t("Remove period")}
                          </ResponsiveActionButton>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </fieldset>
              <ResponsiveActionButton
                icon={Save}
                type="submit"
                disabled={saving}
              >
                {saving
                  ? t("Loading booking settings…")
                  : t("Save availability")}
              </ResponsiveActionButton>
            </form>
          ) : (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">
              {t("Select a Savia member")}
            </p>
          )}
          {currentProfessional && (
            <section
              className="grid gap-3 rounded-lg border p-4"
              aria-labelledby="calendar-heading"
            >
              <h3 id="calendar-heading" className="font-semibold">
                {t("Calendar connection")}
              </h3>
              <p className="max-w-3xl text-sm text-muted-foreground">
                {t(
                  "Choose a personal calendar to check availability and create events. Calendar access is optional and only granted by you.",
                )}
              </p>
              <p className="text-sm" role="status">
                {bootstrap.calendar.provider === "google_calendar"
                  ? bootstrap.calendar.status === "connected"
                    ? t("Google Calendar connected")
                    : t("Calendar needs reconnection")
                  : bootstrap.calendar.provider === "outlook"
                    ? bootstrap.calendar.status === "connected"
                      ? t("Outlook Calendar connected")
                      : t("Calendar needs reconnection")
                    : t("Calendar not connected")}
              </p>
              {bootstrap.calendar.provider &&
                bootstrap.calendar.status !== "connected" && (
                  <p className="text-sm text-destructive">
                    {bootstrap.calendar.status}
                  </p>
                )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void changeCalendar("google_calendar")}
                  className="max-sm:min-h-11"
                >
                  {t("Choose calendar")}: Google
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void changeCalendar("outlook")}
                  className="max-sm:min-h-11"
                >
                  {t("Choose calendar")}: Outlook
                </Button>
                {bootstrap.calendar.provider && (
                  <ResponsiveActionButton
                    icon={Unplug}
                    type="button"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => void changeCalendar(null)}
                  >
                    {t("Calendar not connected")}
                  </ResponsiveActionButton>
                )}
                <Link
                  className="self-center text-sm underline underline-offset-4"
                  to="/my-integrations?tab=connections"
                >
                  {t("Choose calendar")}
                </Link>
              </div>
              {bootstrap.calendar.provider && (
                <div className="grid gap-2 border-t pt-3">
                  <p className="text-sm">
                    {t(
                      bootstrap.calendar.conferenceProvider === "zoom"
                        ? bootstrap.calendar.zoomStatus ===
                            "reconnect_required" ||
                          bootstrap.calendar.zoomStatus === "not_connected"
                          ? "Zoom needs reconnection"
                          : "Zoom authorized for appointments"
                        : "Calendar default (Meet or Teams)",
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "Connect Zoom first. Only you can authorize your Zoom account for appointments.",
                    )}
                  </p>
                  {settings?.conferenceProvider === "jitsi" && (
                    <p className="text-sm text-muted-foreground">
                      {t(
                        "The tenant-wide Jitsi setting takes priority. This Zoom default applies when automatic is selected.",
                      )}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={
                        saving ||
                        bootstrap.calendar.zoomStatus === "not_connected"
                      }
                      onClick={() =>
                        void changeCalendar(bootstrap.calendar.provider, "zoom")
                      }
                    >
                      {t("Use Zoom for appointments")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={saving}
                      onClick={() =>
                        void changeCalendar(bootstrap.calendar.provider, "auto")
                      }
                    >
                      {t("Calendar default (Meet or Teams)")}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}
          {currentProfessional && (
            <section
              className="grid gap-3 rounded-lg border p-4"
              aria-labelledby="my-day-heading"
            >
              <h3 id="my-day-heading" className="font-semibold">
                {t("My Day availability")}
              </h3>
              <p className="max-w-3xl text-sm text-muted-foreground">
                {t(
                  "Grant access to busy times in your current Google or Outlook calendar and imported or subscribed calendars. Meeting details stay private.",
                )}
              </p>
              <p className="text-sm" role="status">
                {bootstrap.agenda?.enabled
                  ? t("My Day access is enabled. Calendar sources: %{count}.", {
                      count: bootstrap.agenda.sourceCount,
                    })
                  : t("My Day access is off.")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void changeMyDayAccess(true)}
                  className="h-auto min-h-11 max-w-full whitespace-normal text-left"
                >
                  {saving
                    ? t("Loading booking settings…")
                    : bootstrap.agenda?.enabled
                      ? t("Update calendar access")
                      : t("Use My Day to block busy times")}
                </Button>
                {bootstrap.agenda?.enabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => void changeMyDayAccess(false)}
                    className="h-auto min-h-11 max-w-full whitespace-normal text-left"
                  >
                    {t("Stop using My Day")}
                  </Button>
                )}
              </div>
            </section>
          )}
        </section>
      )}

      {tab === "reservations" && (
        <section className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{t("Reservations")}</h2>
            <ResponsiveActionButton
              icon={RefreshCw}
              type="button"
              variant="outline"
              onClick={() => setReservationsAttempt((value) => value + 1)}
            >
              {t("Retry")}
            </ResponsiveActionButton>
          </div>
          {appointmentDate && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p className="text-muted-foreground">
                {t("Reservations for %{date}", {
                  date: new Intl.DateTimeFormat(locale, {
                    dateStyle: "long",
                    timeZone: "UTC",
                  }).format(new Date(`${appointmentDate}T00:00:00Z`)),
                })}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSearchParams((current) => {
                    const next = new URLSearchParams(current);
                    next.delete("date");
                    return next;
                  })
                }
              >
                {t("Show upcoming reservations")}
              </Button>
            </div>
          )}
          {reservationsLoading ? (
            <div role="status" className="grid gap-2">
              <span className="sr-only">{t("Reservations")}</span>
              <div className="h-10 animate-pulse rounded bg-muted" />
              <div className="h-16 animate-pulse rounded bg-muted" />
            </div>
          ) : reservationsLoadFailed ? (
            <p role="alert" className="text-sm text-destructive">
              {t("Reservations could not be loaded.")}
            </p>
          ) : reservations.length === 0 ? (
            <p className="rounded-lg border p-6 text-sm text-muted-foreground">
              {t("No reservations in this period.")}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[54rem] text-left text-sm">
                <thead className="bg-muted/60">
                  <tr>
                    {[
                      "Appointment time",
                      "Service",
                      "Professional",
                      "Customer",
                      "Status",
                      "Delivery",
                      "Calendar",
                      "",
                    ].map((label, index) => (
                      <th key={label || index} className="p-3 font-medium">
                        {label ? t(label as keyof typeof bookingMessages) : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reservations.map((reservation) => (
                    <tr key={reservation.id} className="border-t align-top">
                      <td className="whitespace-nowrap p-3">
                        {displayTime(reservation.startsAt, tZone, locale)}
                        <br />
                        <span className="text-muted-foreground">
                          {displayTime(reservation.endsAt, tZone, locale)}
                        </span>
                        {reservation.conference && (
                          <div className="mt-2 whitespace-normal">
                            <BookingConference
                              conference={reservation.conference}
                              status={reservation.status}
                            />
                          </div>
                        )}
                      </td>
                      <td className="p-3">{reservation.serviceName}</td>
                      <td className="p-3">{reservation.professionalName}</td>
                      <td className="p-3">
                        {reservation.customerName}
                        <br />
                        <span className="text-muted-foreground">
                          {reservation.customerEmail}
                        </span>
                      </td>
                      <td className="p-3">
                        {t(
                          reservation.status === "confirmed"
                            ? "Confirmed"
                            : "Cancelled",
                        )}
                      </td>
                      <td
                        className={
                          /fail|error/i.test(reservation.deliveryStatus)
                            ? "p-3 text-destructive"
                            : "p-3"
                        }
                      >
                        {reservation.deliveryStatus}
                      </td>
                      <td
                        className={
                          /fail|error/i.test(reservation.calendarStatus)
                            ? "p-3 text-destructive"
                            : "p-3"
                        }
                      >
                        {calendarStatusLabel(reservation)}
                      </td>
                      <td className="p-3">
                        {reservation.status === "confirmed" &&
                          reservation.conference?.status !== "ready" &&
                          reservation.conference?.status !== "pending" &&
                          (reservation.conference?.status !== "unsupported" ||
                            reservation.availableConferenceProviders?.includes(
                              "zoom",
                            )) && (
                            <div className="mb-2 grid justify-items-start gap-1">
                              {reservation.availableConferenceProviders?.includes(
                                "zoom",
                              ) && (
                                <label className="grid gap-1 text-xs">
                                  {t("Video call platform")}
                                  <select
                                    aria-label={t("Video call platform")}
                                    className="rounded-md border bg-background p-2 text-sm"
                                    value={
                                      selectedConferenceProvider(reservation) ??
                                      "auto"
                                    }
                                    disabled={Boolean(
                                      reservationActions[reservation.id]
                                        ?.pending,
                                    )}
                                    onChange={(event) =>
                                      setConferenceSelections((current) => ({
                                        ...current,
                                        [reservation.id]: event.target.value as
                                          "auto" | "zoom",
                                      }))
                                    }
                                  >
                                    {reservation.availableConferenceProviders.includes(
                                      "auto",
                                    ) && (
                                      <option value="auto">
                                        {t("Calendar default (Meet or Teams)")}
                                      </option>
                                    )}
                                    <option value="zoom">{t("Zoom")}</option>
                                  </select>
                                </label>
                              )}

                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={
                                  !reservation.canGenerateConference ||
                                  Boolean(
                                    reservationActions[reservation.id]?.pending,
                                  )
                                }
                                onClick={() =>
                                  void runReservationAction(
                                    reservation,
                                    "conference",
                                  )
                                }
                              >
                                {reservationActions[reservation.id]?.pending ===
                                "conference"
                                  ? t("Generating video link…")
                                  : t("Generate video link")}
                              </Button>
                              {!reservation.canGenerateConference && (
                                <span className="max-w-48 text-xs text-muted-foreground">
                                  {t(
                                    "Connect an eligible Google Calendar or Outlook calendar to generate a video link.",
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        {reservation.status === "confirmed" && (
                          <ResponsiveActionButton
                            icon={XCircle}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={Boolean(
                              reservationActions[reservation.id]?.pending,
                            )}
                            onClick={() => void cancelReservation(reservation)}
                          >
                            {reservationActions[reservation.id]?.pending ===
                            "cancel"
                              ? t("Cancelling reservation…")
                              : t("Cancel reservation")}
                          </ResponsiveActionButton>
                        )}
                        {reservationActions[reservation.id]?.error && (
                          <p
                            role="alert"
                            className="mt-2 max-w-56 text-xs text-destructive"
                          >
                            {reservationActions[reservation.id]?.error}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {nextReservationPage &&
            !reservationsLoading &&
            !reservationsLoadFailed && (
              <div className="grid justify-items-start gap-2">
                {moreReservationsFailed && (
                  <p role="alert" className="text-sm text-destructive">
                    {t("More reservations could not be loaded.")}
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={loadingMoreReservations}
                  onClick={() => void loadMoreReservations()}
                >
                  {t(
                    loadingMoreReservations
                      ? "Loading reservations…"
                      : "Load more reservations",
                  )}
                </Button>
              </div>
            )}
        </section>
      )}
    </main>
  );
}
