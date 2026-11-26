import { AppLocaleProvider } from "@/i18n/app-locale-provider";
import { StoreContextProvider, memoryStore, useSetLocale } from "ra-core";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicBookingPage } from "./public-booking-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const token = "public-token-1234567890123456";
const slot = {
  startsAt: "2026-10-05T14:00:00Z",
  endsAt: "2026-10-05T14:30:00Z",
};
const catalog = {
  id: "booking-page-identity",
  title: "Book a visit",
  description: "Choose a time",
  timeZone: "America/Bogota",
  cancellationMinutes: 120,
  horizonDays: 30,
  leadMinutes: 0,
  linkScope: { kind: "professional", professionalId: "pro-1" },
  fixedProfessionalId: "pro-1",
  fixedServiceId: null,
  services: [
    {
      id: "consult",
      name: "Consultation",
      description: "First visit",
      durationMinutes: 30,
      professionalIds: ["pro-1"],
    },
  ],
  professionals: [{ id: "pro-1", name: "Ari Ramirez" }],
};

function mountPage(pageToken = token, children?: ReactNode) {
  return render(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        {children}
        <PublicBookingPage token={pageToken} />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
}

function availabilityResponse(availableSlot = slot) {
  return Response.json({
    data: {
      displayTimeZone: "America/Bogota",
      businessTimeZone: "America/Bogota",
      days: [{ date: "2026-10-05", slots: [availableSlot] }],
    },
  });
}

async function chooseAvailability() {
  await screen.findByRole("heading", { name: "Choose a day and time" });
  fireEvent.click(await screen.findByRole("button", { name: "9:00 AM" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

it("does not carry contact details into another public booking link", async () => {
  const nextToken = "another-public-token-1234567890";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://savia.test");
      if (url.pathname.endsWith("/availability")) return availabilityResponse();
      return Response.json({
        data: {
          ...catalog,
          title: url.pathname.endsWith(encodeURIComponent(nextToken))
            ? "Another link"
            : "Original link",
          captcha: { captchaProvider: "disabled" },
        },
      });
    }),
  );

  const page = mountPage();
  await chooseAvailability();
  fireEvent.change(screen.getByLabelText("Your name"), {
    target: { value: "Casey Example" },
  });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "casey@example.test" },
  });

  page.rerender(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <PublicBookingPage token={nextToken} />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  await chooseAvailability();

  expect(screen.getByLabelText("Your name")).toHaveValue("");
  expect(screen.getByLabelText("Email")).toHaveValue("");
});

it("starts a personal one-service link at inline availability and never asks for a professional", async () => {
  const requested: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://savia.test");
      requested.push(url);
      if (url.pathname.endsWith("/availability")) return availabilityResponse();
      return Response.json({
        data: { ...catalog, captcha: { captchaProvider: "disabled" } },
      });
    }),
  );
  mountPage();

  expect(
    await screen.findByRole("heading", { name: "Choose a day and time" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Booking with Ari Ramirez")).toBeInTheDocument();
  expect(screen.queryByLabelText("Professional")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(document.querySelector('input[type="date"]')).toBeNull();
  expect(document.querySelectorAll("select")).toHaveLength(1); // Display time zone only.
  expect(
    await screen.findByRole("button", { name: "9:00 AM" }),
  ).toBeInTheDocument();
  expect(
    requested.some(
      (url) => url.searchParams.get("from") && url.searchParams.get("to"),
    ),
  ).toBe(true);
  expect(screen.getByText("1 / 2")).toBeInTheDocument();
});

it("uses an accurately numbered service step for a multi-service personal link", async () => {
  const multiCatalog = {
    ...catalog,
    services: [
      ...catalog.services,
      {
        id: "follow-up",
        name: "Follow-up",
        description: "Review progress and agree on next steps.",
        durationMinutes: 20,
        professionalIds: ["pro-1"],
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://savia.test");
      if (url.pathname.endsWith("/availability")) return availabilityResponse();
      return Response.json({
        data: { ...multiCatalog, captcha: { captchaProvider: "disabled" } },
      });
    }),
  );
  mountPage();

  await screen.findByRole("heading", { name: "Choose your appointment" });
  expect(screen.getByText("1 / 3")).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Service");
  expect(
    screen.getByText("Review progress and agree on next steps."),
  ).toBeInTheDocument();
  expect(screen.getByText("Booking with Ari Ramirez")).toBeInTheDocument();
  expect(screen.queryByLabelText("Professional")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: /Follow-up/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    await screen.findByRole("heading", { name: "Choose a day and time" }),
  ).toBeInTheDocument();
  expect(screen.getByText("2 / 3")).toBeInTheDocument();
});

it.each([false, true])(
  "keeps the request key and confirmation language when retrying equivalent details (edited: %s)",
  async (editDetails) => {
    function SwitchLanguage() {
      const setLocale = useSetLocale();
      return <button onClick={() => setLocale("es")}>Spanish</button>;
    }
    const posts: Array<{ headers: Headers; body: Record<string, unknown> }> =
      [];
    let failFirst = true;
    let returnedOffsetFormat = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://savia.test");
        if (url.pathname.endsWith("/availability"))
          return availabilityResponse(
            returnedOffsetFormat
              ? { ...slot, startsAt: slot.startsAt.replace(/Z$/, "+00:00") }
              : slot,
          );
        if (url.pathname.endsWith("/reservations")) {
          posts.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
          });
          if (failFirst) {
            failFirst = false;
            return Response.json(
              { error: { message: "Try again" } },
              { status: 503 },
            );
          }
          return Response.json({
            data: {
              reservation: {
                ...slot,
                status: "confirmed",
                conference: {
                  provider: "google_meet",
                  joinUrl: "https://meet.google.com/abc-defg-hij",
                  status: "ready",
                },
              },
              managementUrl: "https://savia.test/manage/private-token",
            },
          });
        }
        return Response.json({
          data: { ...catalog, captcha: { captchaProvider: "disabled" } },
        });
      }),
    );
    mountPage(token, <SwitchLanguage />);
    await screen.findByRole("heading", { name: "Book a visit" });
    await chooseAvailability();
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Casey" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "casey@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Book appointment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Retry with the same request",
    );
    if (editDetails) {
      returnedOffsetFormat = true;
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      const next = screen.getByRole("button", { name: "Continue" });
      await waitFor(() => expect(next).toBeEnabled());
      fireEvent.click(next);
      fireEvent.change(screen.getByLabelText("Your name"), {
        target: { value: " Casey " },
      });
      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "Casey@Example.TEST" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Spanish" }));
    expect(await screen.findByLabelText("Tu nombre")).toHaveValue(
      editDetails ? " Casey " : "Casey",
    );
    expect(screen.getByLabelText("Correo electrónico")).toHaveValue(
      editDetails ? "Casey@Example.TEST" : "casey@example.test",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: editDetails ? "Reservar cita" : "Reintentar reserva",
      }),
    );
    await screen.findByText("Cita confirmada");
    expect(screen.getByRole("link", { name: /Google Meet/ })).toHaveAttribute(
      "href",
      "https://meet.google.com/abc-defg-hij",
    );

    expect(posts).toHaveLength(2);
    expect(posts[0].headers.get("Idempotency-Key")).toBeTruthy();
    expect(posts[1].headers.get("Idempotency-Key")).toBe(
      posts[0].headers.get("Idempotency-Key"),
    );
    expect(posts[0].body).toEqual(
      expect.objectContaining({
        serviceId: "consult",
        professionalId: "pro-1",
        customerName: "Casey",
        customerEmail: "casey@example.test",
        customerLocale: "en",
      }),
    );
    expect(posts[1].body.customerLocale).toBe("en");
  },
);

it.each(["confirmed", "cancelled"] as const)(
  "shows the current stored appointment after retrying a booking that is now %s",
  async (status) => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "https://savia.test").pathname;
        if (path.endsWith("/availability")) return availabilityResponse();
        if (path.endsWith("/reservations")) {
          if (++attempt === 1) return new Response(null, { status: 503 });
          return Response.json({
            data: {
              reservation: {
                startsAt: "2026-10-07T16:00:00Z",
                endsAt: "2026-10-07T16:30:00Z",
                status,
                conference: {
                  provider: "google_meet",
                  joinUrl: "https://meet.google.com/abc-defg-hij",
                  status: "ready",
                },
              },
              managementUrl: "https://savia.test/manage/private-token",
            },
          });
        }
        return Response.json({
          data: { ...catalog, captcha: { captchaProvider: "disabled" } },
        });
      }),
    );
    mountPage();
    await chooseAvailability();
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Casey" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "casey@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Book appointment" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry booking" }),
    );
    expect(
      await screen.findByRole("heading", { name: `Appointment ${status}` }),
    ).toBeVisible();
    expect(
      screen.getByText(/Wednesday, October 7, 2026.*11:00 AM/),
    ).toBeVisible();
    if (status === "cancelled")
      expect(screen.queryByRole("link", { name: /Google Meet/ })).toBeNull();
  },
);

it("shows no confirmation from a booking request made on a different public link", async () => {
  const nextToken = "another-public-token-1234567890";
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://savia.test");
    if (url.pathname.endsWith("/availability")) return availabilityResponse();
    if (url.pathname.endsWith("/reservations")) return pending;
    return Response.json({
      data: {
        ...catalog,
        title: url.pathname.endsWith(nextToken)
          ? "Another link"
          : "Original link",
        captcha: { captchaProvider: "disabled" },
      },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const page = mountPage();
  await chooseAvailability();
  fireEvent.change(screen.getByLabelText("Your name"), {
    target: { value: "Casey" },
  });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "casey@example.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Book appointment" }));
  expect(
    fetcher.mock.calls.some(([path]) => String(path).endsWith("/reservations")),
  ).toBe(true);

  page.rerender(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <PublicBookingPage token={nextToken} />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  expect(
    await screen.findByRole("heading", { name: "Another link" }),
  ).toBeVisible();
  await act(async () =>
    finish(
      Response.json({
        data: {
          reservation: { ...slot, status: "confirmed" },
          managementUrl: "https://savia.test/manage/previous-link",
        },
      }),
    ),
  );
  expect(screen.getByRole("heading", { name: "Another link" })).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Manage or cancel this appointment" }),
  ).toBeNull();
});

it.each([
  {
    conflict: "JSON",
    message:
      "That time conflicts with another meeting or appointment. Choose another available time.",
  },
  {
    conflict: "empty",
    message: "That time is no longer available. Choose another available time.",
  },
])(
  "preserves contact details and reloads availability after a $conflict slot conflict",
  async ({ conflict, message }) => {
    const captchaOptions: Array<Record<string, unknown>> = [];
    const posts: Array<Record<string, unknown>> = [];
    let rangeRequests = 0;
    let widgetId = 0;
    window.turnstile = {
      render: vi.fn(
        (_element: HTMLElement, options: Record<string, unknown>) => {
          captchaOptions.push(options);
          widgetId += 1;
          return `widget-${widgetId}`;
        },
      ),
      remove: vi.fn(),
      reset: vi.fn(),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://savia.test");
        if (url.pathname.endsWith("/availability")) {
          rangeRequests += 1;
          return availabilityResponse();
        }
        if (url.pathname.endsWith("/reservations")) {
          posts.push(JSON.parse(String(init?.body)));
          if (posts.length === 1)
            return conflict === "empty"
              ? new Response(null, { status: 409 })
              : Response.json(
                  {
                    error: {
                      code: "BOOKING_TIME_CONFLICT",
                      message: "Slot conflicts with a meeting",
                    },
                  },
                  { status: 409 },
                );
          return Response.json({
            data: {
              reservation: { ...slot, status: "confirmed" },
              managementUrl: "https://savia.test/manage/private-token",
            },
          });
        }
        return Response.json({
          data: {
            ...catalog,
            captcha: { captchaProvider: "turnstile", siteKey: "site-key" },
          },
        });
      }),
    );
    mountPage();
    await screen.findByRole("heading", { name: "Book a visit" });
    await chooseAvailability();
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Casey" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "casey@example.test" },
    });
    await waitFor(() => expect(captchaOptions).toHaveLength(1));
    act(() =>
      (captchaOptions[0].callback as (proof: string) => void)("first-proof"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Book appointment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    await waitFor(() => expect(rangeRequests).toBeGreaterThan(1));
    expect(window.turnstile.remove).toHaveBeenCalledWith("widget-1");
    fireEvent.click(await screen.findByRole("button", { name: "9:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Your name")).toHaveValue("Casey");
    await waitFor(() => expect(captchaOptions).toHaveLength(2));
    act(() =>
      (captchaOptions[1].callback as (proof: string) => void)("fresh-proof"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Book appointment" }));
    await screen.findByText("Appointment confirmed");
    expect(posts).toHaveLength(2);
    expect(posts[0].captchaToken).toBe("first-proof");
    expect(posts[1].captchaToken).toBe("fresh-proof");
  },
);

it.each(["calendar", "language"])(
  "requires fresh verification after remounting the CAPTCHA through %s",
  async (reason) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    function SwitchLanguage() {
      const setLocale = useSetLocale();
      return <button onClick={() => setLocale("es")}>Spanish</button>;
    }
    const verify: Array<(proof: string) => void> = [];
    const remove = vi.fn();
    vi.stubGlobal("turnstile", {
      render: vi.fn(
        (
          _element: HTMLElement,
          options: { callback: (proof: string) => void },
        ) => {
          verify.push(options.callback);
          return `widget-${verify.length}`;
        },
      ),
      remove,
      reset: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://savia.test");
        if (url.pathname.endsWith("/availability"))
          return availabilityResponse();
        return Response.json({
          data: {
            ...catalog,
            captcha: { captchaProvider: "turnstile", siteKey: "site-key" },
          },
        });
      }),
    );
    mountPage(token, <SwitchLanguage />);
    await chooseAvailability();
    await waitFor(() => expect(verify).toHaveLength(1));
    act(() => verify[0]("previous-proof"));
    expect(
      screen.getByRole("button", { name: "Book appointment" }),
    ).toBeEnabled();

    if (reason === "calendar") {
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      const next = screen.getByRole("button", { name: "Continue" });
      await waitFor(() => expect(next).toBeEnabled());
      fireEvent.click(next);
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Spanish" }));
    }
    const submit = await screen.findByRole("button", {
      name: reason === "calendar" ? "Book appointment" : "Reservar cita",
    });
    await waitFor(() => expect(verify).toHaveLength(2));
    expect(remove).toHaveBeenCalledWith("widget-1");
    expect(submit).toBeDisabled();

    act(() => verify[0]("late-proof"));
    expect(submit).toBeDisabled();
    act(() => verify[1]("fresh-proof"));
    expect(submit).toBeEnabled();
  },
);

it("retries CAPTCHA setup without losing the booking details or submitting early", async () => {
  let verify: ((proof: string) => void) | undefined;
  const renderCaptcha = vi
    .fn(
      (
        _element: HTMLElement,
        options: { callback: (proof: string) => void },
      ) => {
        verify = options.callback;
        return "recovered-widget";
      },
    )
    .mockImplementationOnce(() => {
      throw new Error("CAPTCHA did not load");
    });
  vi.stubGlobal("turnstile", {
    render: renderCaptcha,
    remove: vi.fn(),
    reset: vi.fn(),
  });
  const book = vi.fn((_input?: RequestInit) =>
    Response.json({
      data: {
        reservation: { ...slot, status: "confirmed" },
        managementUrl: "https://savia.test/manage/demo",
      },
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://savia.test");
      if (url.pathname.endsWith("/availability")) return availabilityResponse();
      if (url.pathname.endsWith("/reservations")) return book(init);
      return Response.json({
        data: {
          ...catalog,
          captcha: { captchaProvider: "turnstile", siteKey: "site-key" },
        },
      });
    }),
  );
  mountPage();
  await chooseAvailability();
  fireEvent.change(screen.getByLabelText("Your name"), {
    target: { value: "Casey" },
  });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "casey@example.test" },
  });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Verification could not load",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
  await waitFor(() => expect(renderCaptcha).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Your name")).toHaveValue("Casey");
  expect(screen.getByLabelText("Email")).toHaveValue("casey@example.test");
  const submit = screen.getByRole("button", { name: "Book appointment" });
  expect(submit).toBeDisabled();
  expect(book).not.toHaveBeenCalled();

  act(() => verify?.("fresh-proof"));
  fireEvent.click(submit);
  await screen.findByText("Appointment confirmed");
  expect(book).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(book.mock.calls[0][0]?.body))).toMatchObject({
    captchaToken: "fresh-proof",
    startsAt: slot.startsAt,
    customerName: "Casey",
    customerEmail: "casey@example.test",
  });
});

it.each([true, false])(
  "waits to check the selected time again after availability fails (still available: %s)",
  async (availableAfterRetry) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    let failAvailability = false;
    let retried = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://savia.test");
        if (url.pathname.endsWith("/availability")) {
          if (failAvailability) return new Response(null, { status: 503 });
          if (retried && !availableAfterRetry)
            return Response.json({
              data: {
                displayTimeZone: catalog.timeZone,
                businessTimeZone: catalog.timeZone,
                days: [{ date: "2026-10-05", slots: [] }],
              },
            });
          return availabilityResponse();
        }
        return Response.json({
          data: { ...catalog, captcha: { captchaProvider: "disabled" } },
        });
      }),
    );
    mountPage();
    await chooseAvailability();
    failAvailability = true;
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Available times could not be loaded.",
    );
    const next = screen.getByRole("button", { name: "Continue" });
    expect(next).toBeDisabled();
    failAvailability = false;
    retried = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    if (availableAfterRetry) {
      await waitFor(() => expect(next).toBeEnabled());
      fireEvent.click(next);
      expect(
        screen.getByRole("button", { name: "Book appointment" }),
      ).toBeEnabled();
    } else {
      await screen.findByText("No availability in this month.");
      expect(next).toBeDisabled();
    }
  },
);
