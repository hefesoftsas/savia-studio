import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Building2, CalendarDays } from "lucide-react";
import {
  buildTenantOrigin,
  KNOWN_CANONICAL_HOSTS,
  normalizeTenantSlug,
} from "@savia/tenant-host";
import type { ApiClient } from "@/api/api-client";
import type { paths } from "@/api/generated/openapi";
import { useSessionGeneration } from "@/auth/session-scope";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/core";
import { readKey } from "@/queries/query-keys";
import { bookingMessages } from "./booking-messages";

type TenantCatalog =
  paths["/v1/tenants"]["get"]["responses"][200]["content"]["application/json"];

export function BookingWorkspacePicker({
  apiClient,
  hostname,
}: {
  apiClient: Pick<ApiClient, "get">;
  hostname: string;
}) {
  const t = useMessages(bookingMessages);
  const headingId = useId();
  const sessionGeneration = useSessionGeneration();
  const canOpenWorkspace = KNOWN_CANONICAL_HOSTS.includes(hostname);
  const tenants = useQuery({
    queryKey: readKey(
      { kind: "principal", id: hostname, sessionGeneration },
      "booking-workspaces",
    ),
    queryFn: ({ signal }) =>
      apiClient.get<TenantCatalog>("/v1/tenants", { signal }),
    enabled: canOpenWorkspace,
    retry: false,
  });
  const workspaces =
    tenants.data?.data.flatMap((tenant) => {
      const slug = normalizeTenantSlug(tenant.idSlug);
      if (tenant.kind !== "commercial" || !tenant.isActive || !slug) return [];
      const origin = buildTenantOrigin(slug, hostname);
      return [
        {
          id: tenant.id,
          name: tenant.name,
          host: new URL(origin).hostname,
          href: `${origin}/#/bookings`,
        },
      ];
    }) ?? [];

  return (
    <section
      aria-labelledby={headingId}
      className="mx-auto my-auto w-full max-w-xl rounded-2xl border bg-card text-card-foreground"
    >
      <header className="p-5 sm:p-8">
        <div className="grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
          <CalendarDays className="size-6" aria-hidden="true" />
        </div>
        <h1
          id={headingId}
          className="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          {t(canOpenWorkspace ? "Choose an organization" : "Appointments")}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t("Open your organization’s workspace to view Bookings.")}
        </p>
      </header>
      {canOpenWorkspace && (
        <div className="border-t px-5 py-4 sm:px-8">
          {tenants.isPending ? (
            <p role="status" className="py-2 text-sm text-muted-foreground">
              {t("Loading organizations…")}
            </p>
          ) : tenants.isError ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="alert" className="text-sm text-destructive">
                {t("We couldn’t load your organizations.")}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void tenants.refetch()}
              >
                {t("Retry")}
              </Button>
            </div>
          ) : workspaces.length === 0 ? (
            <p
              role="status"
              className="py-2 text-sm leading-6 text-muted-foreground"
            >
              {t(
                "You have no available organizations. Ask an administrator for access.",
              )}
            </p>
          ) : (
            <ul className="divide-y">
              {workspaces.map((workspace) => (
                <li key={workspace.id} className="py-1">
                  <Button
                    asChild
                    variant="ghost"
                    className="group h-auto min-h-14 w-full justify-start gap-3 whitespace-normal py-2 text-left"
                  >
                    <a href={workspace.href}>
                      <Building2
                        className="size-5 text-primary"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 wrap-anywhere">
                        <span className="block font-medium">
                          {workspace.name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {workspace.host}
                        </span>
                      </span>
                      <ArrowRight
                        className="size-4 text-muted-foreground transition-colors group-hover:text-primary"
                        aria-hidden="true"
                      />
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
