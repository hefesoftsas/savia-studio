import { useAccessRealtime } from "@/realtime/use-access-realtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useWatch } from "react-hook-form";
import { useInput } from "ra-core";
import { useQuery } from "@tanstack/react-query";
import { useAppServices } from "@/features/assistant/assistant-context";
import { createAccessControlClient } from "@/api/access-control-client";
import { useMessages } from "@/i18n/core";
import { accessMessages } from "@/i18n/locales/access";
import { Button } from "@/components/ui/button";
import { MAX_CUSTOM_ROLES_PER_USER } from "@savia/studio-shared/access-control";

export function UserAccessRoles() {
  const { apiClient } = useAppServices();
  const t = useMessages(accessMessages);
  const tenantId = useWatch({ name: "tenantId" });
  const platformAdmin = useWatch({ name: "platformAdmin" });
  const scope = platformAdmin
    ? "tenant:0"
    : tenantId
      ? `tenant:${tenantId}`
      : "";
  useAccessRealtime(scope);
  const { field } = useInput({ source: "accessRoleIds", defaultValue: [] });
  const previousScope = useRef(scope);
  const [removedRoles, setRemovedRoles] = useState(false);
  const roles = useQuery({
    queryKey: ["access-control", "roles", scope],
    enabled: Boolean(scope),
    queryFn: () => createAccessControlClient(apiClient).listRoles(scope),
  });
  const available = useMemo(
    () =>
      roles.data?.roles.filter((role) => !role.protected && role.enabled) ?? [],
    [roles.data],
  );
  const selected: string[] = field.value ?? [];
  const atRoleLimit = selected.length >= MAX_CUSTOM_ROLES_PER_USER;
  useEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      field.onChange([]);
      setRemovedRoles(false);
      return;
    }
    if (!roles.isSuccess || roles.isFetching || roles.isPlaceholderData) return;
    const selectedIds: string[] = field.value ?? [];
    const availableIds = new Set(available.map((role) => role.id));
    const next = selectedIds.filter((id) => availableIds.has(id));
    if (next.length < selectedIds.length) {
      field.onChange(next);
      setRemovedRoles(true);
    }
  }, [
    scope,
    field.value,
    field.onChange,
    available,
    roles.isSuccess,
    roles.isFetching,
    roles.isPlaceholderData,
  ]);
  return (
    <fieldset className="space-y-3 border-t pt-4 md:col-span-2">
      <legend className="text-sm font-medium">{t("Tenant roles")}</legend>
      <p className="text-sm text-muted-foreground">
        {t(
          "Select roles created in Roles and permissions for this tenant. They add access to the base role.",
        )}
      </p>
      {removedRoles && (
        <p role="status" className="text-sm">
          {t("Some selected roles are no longer available and were removed.")}
        </p>
      )}
      {atRoleLimit && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(
            "You can assign up to %{count} custom roles per user. Deselect a role to choose another.",
            { count: MAX_CUSTOM_ROLES_PER_USER },
          )}
        </p>
      )}
      {!scope ? (
        <p className="text-sm">{t("Select a tenant to see its roles.")}</p>
      ) : roles.isPending ? (
        <p role="status">{t("Loading permissions…")}</p>
      ) : roles.error ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{t("Unable to load tenant roles.")}</p>
          <Button
            type="button"
            variant="outline"
            className="max-sm:size-11 max-sm:p-0 max-sm:has-[>svg]:px-0"
            onClick={() => void roles.refetch()}
          >
            <RotateCcw aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">
              {t("Reload permissions")}
            </span>
          </Button>
        </div>
      ) : available.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "No enabled custom roles in this tenant. Roles from other tenants are not available here.",
          )}
        </p>
      ) : (
        available.map((role) => (
          <label key={role.id} className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.includes(role.id)}
              disabled={atRoleLimit && !selected.includes(role.id)}
              onBlur={field.onBlur}
              onChange={(event) =>
                field.onChange(
                  event.target.checked
                    ? [...selected, role.id]
                    : selected.filter((id) => id !== role.id),
                )
              }
            />
            <span>
              <span className="block font-medium">{role.label}</span>
              {role.description && (
                <span className="text-muted-foreground">
                  {role.description}
                </span>
              )}
            </span>
          </label>
        ))
      )}
    </fieldset>
  );
}
