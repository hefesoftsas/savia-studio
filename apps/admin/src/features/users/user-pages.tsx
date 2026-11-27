import {
  EmailVerificationField,
  EmailVerificationStatus,
} from "./email-verification-field";
import {
  ResourceEditSync,
  ResourceReadSync,
} from "@/realtime/resource-realtime";
import { UserAccessRoles } from "./user-access-roles";
import { useMessages } from "@/i18n/core";
import { settingsMessages } from "@/i18n/locales/settings";
import { useEffect, useState, type ReactNode } from "react";
import {
  Ban,
  CircleAlert,
  ChevronsUpDown,
  KeyRound,
  LogOut,
  Plus,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Info,
  UsersRound,
} from "lucide-react";
import {
  maxLength,
  minLength,
  required,
  useCanAccess,
  useChoicesContext,
  useDataProvider,
  useDelete,
  useEditContext,
  useGetList,
  useGetOne,
  useListContext,
  useNotify,
  usePermissions,
  useRecordContext,
  useRedirect,
  useRefresh,
  useResourceContext,
  useSaveContext,
  useShowContext,
  useTranslate,
} from "ra-core";
import MicrosoftExcel from "@thesvg/react/microsoft-excel";
import { useQueryClient } from "@tanstack/react-query";
import { useFormContext, useWatch } from "react-hook-form";
import {
  AutocompleteInput,
  BooleanInput,
  CancelButton,
  Count,
  Create,
  CreateButton,
  DataTable,
  Edit,
  EditButton,
  ExportButton,
  FormToolbar,
  List,
  ListPagination,
  ReferenceInput,
  SaveButton,
  SelectInput,
  Show,
  ShowButton,
  SimpleForm,
  TextInput,
} from "@/components/admin";
import { Confirm } from "@/components/admin/confirm";
import { isOfflineError } from "@/offline/offline-error";
import { applyRealtimeListEvent } from "@/realtime/realtime-list";
import {
  useRealtimeTopics,
  type RealtimeChangeEvent,
} from "@/realtime/use-realtime";
import {
  tenantSearchText,
  type TenantRecord,
} from "@/api/tenant-data-provider";
import type {
  IdentityUserDataProvider,
  UserFormData,
  UserRecord,
} from "@/api/identity-user-data-provider";
import type { AgencyAccessRole } from "@/api/identity-client";
import type { AuthPermissions } from "@/auth/auth-session";
import { TenantUserCapacity } from "./tenant-user-capacity";
import { TenantSignInSettingsLink } from "@/features/tenant-sso/tenant-sign-in-links";
import {
  platformAdminUserUpdateData,
  tenantAdminTenantId,
  tenantAdminUserUpdateData,
  userCreateScope,
} from "./tenant-user-scope";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { IconButtonWithTooltip } from "@/components/admin/icon-button-with-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const requiredField = required("ra.validation.required");
const temporaryPasswordValidators = [minLength(12), maxLength(128)];
const requiredNameField = Object.assign(
  (value: string | null | undefined, values: unknown) =>
    requiredField(value?.trim(), values),
  { isRequired: true },
);

const tenantRoleChoices: { id: AgencyAccessRole; name: string }[] = [
  { id: "tenant_admin", name: "Administrador de tenant" },
  { id: "operator", name: "Operador" },
  { id: "viewer", name: "Solo lectura" },
];

function userFilters(
  t: ReturnType<typeof useMessages<typeof settingsMessages>>,
) {
  return [
    <TextInput
      key="q"
      source="q"
      label={false}
      alwaysOn
      placeholder={t("Buscar por usuario o correo…")}
      inputClassName="w-full sm:w-72"
    />,
  ];
}

const userStoreKeys = {
  active: "users.active",
  inactive: "users.inactive",
  all: "users.all",
};

type UserStatusView = keyof typeof userStoreKeys;

function getUserStatusView(isActive: unknown): UserStatusView {
  if (isActive === true) return "active";
  if (isActive === false) return "inactive";
  return "all";
}

type ApiErrorLike = {
  code?: string;
  status?: number;
};

function asApiErrorLike(error: unknown): ApiErrorLike {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as Record<string, unknown>;
  const nested =
    typeof candidate.body === "object" && candidate.body !== null
      ? (candidate.body as Record<string, unknown>).error
      : undefined;
  const nestedRecord =
    typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>)
      : undefined;
  const code =
    (typeof candidate.code === "string" && candidate.code) ||
    (nestedRecord && typeof nestedRecord.code === "string"
      ? (nestedRecord.code as string)
      : undefined);
  const status =
    typeof candidate.status === "number" ? candidate.status : undefined;
  return { code, status };
}

export function deleteUserErrorMessage(
  error: unknown,
): keyof typeof settingsMessages {
  const { code, status } = asApiErrorLike(error);
  if (code === "IDENTITY_DELETION_PENDING") {
    return "La eliminación quedó pendiente. Puedes reintentar desde la ficha del usuario o desde Inactivos.";
  }
  if (isOfflineError(error)) {
    return "Sin conexión o servicio no disponible. Inténtalo de nuevo.";
  }
  if (code === "LAST_ACTIVE_MEMBER") {
    return "No se puede eliminar: el tenant debe conservar al menos un usuario activo.";
  }
  if (code === "AUTHORIZATION_FORBIDDEN") {
    return "No tienes permiso para eliminar este usuario (no puedes eliminarte a ti mismo).";
  }
  if (
    code === "VALIDATION_ERROR" ||
    code === "LAST_ACTIVE_PLATFORM_ADMINISTRATOR"
  ) {
    return "No se puede eliminar al último administrador de plataforma activo.";
  }
  if (code === "NOT_FOUND" || status === 404) {
    return "El usuario ya no existe. Actualiza la lista.";
  }
  if (status === 403) {
    return "No tienes permiso para eliminar usuarios.";
  }
  return "No fue posible eliminar el usuario.";
}

/**
 * Pessimistic delete with confirmation for identity users.
 *
 * The generic undoable DeleteButton hides backend guards behind an
 * optimistic toast, so a rejected delete looks like it worked and then the
 * row "reappears". This button waits for the server and surfaces the reason
 * in Spanish, matching the pessimistic pattern used elsewhere (tenants).
 */
function UserDeleteButton({
  iconOnly = false,
  label,
  redirectTo = "list",
}: {
  iconOnly?: boolean;
  label?: string;
  redirectTo?: "list" | false;
}) {
  const translate = useTranslate();
  const t = useMessages(settingsMessages);
  const record = useRecordContext<UserRecord>();
  const showLabelOnMobile = Boolean(record?.deletionPending && !iconOnly);
  const displayLabel = record?.deletionPending
    ? t("Reintentar eliminación")
    : (label ??
      translate("savia.users.actions.delete", { _: "Eliminar usuario" }));
  const resource = useResourceContext() ?? "users";
  const { canAccess } = useCanAccess({
    resource,
    action: "delete",
    record,
  });
  const notify = useNotify();
  const refresh = useRefresh();
  const redirect = useRedirect();
  const queryClient = useQueryClient();
  const [deleteOne, { isPending }] = useDelete();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!canAccess || record?.id == null) return null;

  const handleConfirm = () => {
    deleteOne(
      resource,
      { id: record.id, previousData: record },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          void queryClient.invalidateQueries({
            queryKey: ["tenant-user-capacity"],
          });
          notify(
            translate("savia.users.notifications.userDeleted", {
              _: "Usuario eliminado.",
            }),
            { type: "success" },
          );
          refresh();
          if (redirectTo) redirect(redirectTo, resource);
        },
        onError: (error: unknown) => {
          setConfirmOpen(false);
          if (asApiErrorLike(error).code === "IDENTITY_DELETION_PENDING") {
            void queryClient.invalidateQueries({
              queryKey: ["tenant-user-capacity"],
            });
            refresh();
          }
          notify(t(deleteUserErrorMessage(error)), { type: "error" });
        },
      },
    );
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={iconOnly ? "icon" : "default"}
        aria-label={displayLabel}
        title={iconOnly ? displayLabel : undefined}
        disabled={isPending}
        onClick={(event) => {
          event.stopPropagation();
          setConfirmOpen(true);
        }}
        className={`${showLabelOnMobile ? "max-sm:min-h-11" : "max-sm:size-11"} cursor-pointer hover:bg-destructive/10! text-destructive! border-destructive! focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40`}
      >
        <Trash2 className="size-4" />
        {iconOnly ? null : (
          <span
            className={showLabelOnMobile ? undefined : "sr-only sm:not-sr-only"}
          >
            {displayLabel}
          </span>
        )}
      </Button>
      <Confirm
        isOpen={confirmOpen}
        title={
          record.deletionPending
            ? t("Reintentar eliminación")
            : translate("savia.users.dialogs.deleteTitle", {
                _: "Eliminar usuario",
              })
        }
        content={translate("savia.users.dialogs.deleteContent", {
          name: record.displayName ?? record.email,
          _: `¿Eliminar a ${record.displayName ?? record.email}? Esta acción no se puede deshacer.`,
        })}
        confirm="ra.action.delete"
        confirmColor="warning"
        ConfirmIcon={Trash2}
        loading={isPending}
        onClose={() => {
          if (!isPending) setConfirmOpen(false);
        }}
        onConfirm={handleConfirm}
      />
    </>
  );
}

export function UserList() {
  const t = useMessages(settingsMessages);
  const translate = useTranslate();
  return (
    <List
      title={translate("savia.users.title", { _: "Usuarios" })}
      sort={{ field: "displayName", order: "ASC" }}
      filterDefaultValues={{ isActive: true }}
      filters={userFilters(t)}
      perPage={20}
      queryOptions={{ retry: false }}
      pagination={<ListPagination rowsPerPageOptions={[10, 20, 50, 100]} />}
      actions={<UserListActions />}
    >
      <UserListContent />
    </List>
  );
}

function UserListContent() {
  const t = useMessages(settingsMessages);
  const { data, error, isPending, refetch } = useListContext<UserRecord>();
  const hasUsers = Array.isArray(data) && data.length > 0;

  if (error && !isPending && !hasUsers) {
    return (
      <section
        role="alert"
        className="my-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
      >
        <p className="text-sm">
          {t(
            "No se pudo cargar el listado de usuarios. Comprueba tu conexión e inténtalo de nuevo.",
          )}
        </p>
        <Button type="button" variant="outline" onClick={() => void refetch()}>
          {t("Reintentar")}
        </Button>
      </section>
    );
  }

  return (
    <>
      <TenantUserScope />
      <UserTabbedTable />
    </>
  );
}

function TenantUserScope() {
  const t = useMessages(settingsMessages);
  const translate = useTranslate();
  const { permissions } = usePermissions<AuthPermissions>();
  const { filterValues, setFilters, displayedFilters } =
    useListContext<UserRecord>();
  const isPlatformAdmin = Boolean(permissions?.canManageIdentity);
  const tenantAdminId = tenantAdminTenantId(permissions?.memberships);
  const selectedTenantId = Number(filterValues.tenantId);
  const tenantId = isPlatformAdmin
    ? Number.isSafeInteger(selectedTenantId) && selectedTenantId >= 0
      ? selectedTenantId
      : undefined
    : tenantAdminId;
  const tenantName = useTenantName(tenantId);
  if (tenantId === undefined) return null;

  const clearTenantScope = () => {
    const { tenantId: _tenantId, ...filters } = filterValues;
    setFilters(filters, displayedFilters);
  };

  return (
    <>
      <TenantUserCapacity
        tenantId={tenantId}
        platformCanEdit={isPlatformAdmin}
      />
      <section className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div>
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {tenantName
              ? t("Users in %{name}", { name: tenantName })
              : t("Tenant users")}
            <IconButtonWithTooltip
              label={t(
                "Este listado muestra únicamente las personas asignadas a este tenant.",
              )}
              className="size-11 p-0 sm:size-5"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </IconButtonWithTooltip>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tenantId > 0 && <TenantSignInSettingsLink tenantId={tenantId} />}
          {isPlatformAdmin && (
            <Button
              type="button"
              variant="outline"
              onClick={clearTenantScope}
              className="max-sm:size-11 max-sm:p-0 max-sm:has-[>svg]:px-0"
            >
              <UsersRound aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">
                {translate("savia.users.viewAllUsers", {
                  _: "Ver todos los usuarios",
                })}
              </span>
            </Button>
          )}
        </div>
      </section>
    </>
  );
}

function useUserRealtimeScope() {
  const { permissions, isPending } = usePermissions<AuthPermissions>();
  const platformCanEdit = Boolean(permissions?.canManageIdentity);
  const tenantId = platformCanEdit
    ? undefined
    : tenantAdminTenantId(permissions?.memberships);
  return {
    platformCanEdit,
    subscription: {
      topics: platformCanEdit ? ["users"] : ["access-control"],
      tenantId,
      enabled: !isPending && (platformCanEdit || tenantId !== undefined),
      accepts: (event: RealtimeChangeEvent) =>
        platformCanEdit || event.collection === "memberships",
    },
  };
}

function UserListActions() {
  const translate = useTranslate();
  const queryClient = useQueryClient();
  const { platformCanEdit, subscription } = useUserRealtimeScope();
  const { accepts, ...scope } = subscription;
  useRealtimeTopics({
    ...scope,
    onConnected: (reason) => {
      if (reason === "subscription-change") return;
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      void queryClient.invalidateQueries({
        queryKey: ["tenant-user-capacity"],
      });
    },
    onEvent: (event) => {
      if (!accepts(event)) return;
      if (platformCanEdit) {
        applyRealtimeListEvent(queryClient, "users", event);
      } else {
        void queryClient.invalidateQueries({ queryKey: ["users"] });
      }
      void queryClient.invalidateQueries({
        queryKey: ["tenant-user-capacity"],
      });
    },
  });
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 [&_button]:max-sm:size-11 [&_a]:max-sm:min-h-11 [&_a]:max-sm:min-w-11">
      <ExportButton
        iconOnly
        label={translate("savia.users.exportExcel", {
          _: "Exportar a Excel",
        })}
        icon={<MicrosoftExcel aria-hidden className="size-4" />}
      />
      <CreateButton
        iconOnly
        variant="default"
        label={translate("savia.users.newUser", { _: "Nuevo usuario" })}
      />
    </div>
  );
}

function UserTabbedTable() {
  const translate = useTranslate();
  const { filterValues, setFilters, displayedFilters } =
    useListContext<UserRecord>();
  const statusView = getUserStatusView(filterValues.isActive);
  const { isActive: _isActive, ...filtersWithoutStatus } = filterValues;
  const setStatus = (nextStatus: UserStatusView) => {
    setFilters(
      nextStatus === "all"
        ? filtersWithoutStatus
        : { ...filtersWithoutStatus, isActive: nextStatus === "active" },
      displayedFilters,
    );
  };

  return (
    <Tabs
      value={statusView}
      onValueChange={(value) => setStatus(value as UserStatusView)}
      className="mb-4 gap-2"
    >
      <TabsList className="group-data-[orientation=horizontal]/tabs:h-auto min-h-11 w-full flex-wrap justify-start overflow-visible [&>[role=tab]]:min-h-11">
        <TabsTrigger value="active">
          {translate("savia.users.tabs.active", { _: "Activos" })}
          <Badge variant="outline" className="hidden md:inline-flex">
            <Count filter={{ ...filtersWithoutStatus, isActive: true }} />
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="inactive">
          {translate("savia.users.tabs.inactive", { _: "Suspendidos" })}
          <Badge variant="outline" className="hidden md:inline-flex">
            <Count filter={{ ...filtersWithoutStatus, isActive: false }} />
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="all">
          {translate("savia.users.tabs.all", { _: "Todos" })}
          <Badge variant="outline" className="hidden md:inline-flex">
            <Count filter={filtersWithoutStatus} />
          </Badge>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="active">
        <UserTable storeKey={userStoreKeys.active} />
      </TabsContent>
      <TabsContent value="inactive">
        <UserTable storeKey={userStoreKeys.inactive} />
      </TabsContent>
      <TabsContent value="all">
        <UserTable storeKey={userStoreKeys.all} />
      </TabsContent>
    </Tabs>
  );
}

function UserTable({ storeKey }: { storeKey: string }) {
  const t = useMessages(settingsMessages);
  const translate = useTranslate();
  return (
    <DataTable<UserRecord>
      storeKey={storeKey}
      bulkActionButtons={false}
      rowClick="show"
    >
      <DataTable.Col
        source="displayName"
        label={translate("savia.users.fields.name", { _: "Usuario" })}
        className="font-medium"
        render={(record) => (
          <>
            {record.displayName}
            {record.deletionPending && (
              <span className="block text-sm font-normal text-muted-foreground sm:hidden">
                {t("Eliminación pendiente")}
              </span>
            )}
          </>
        )}
      />
      <DataTable.Col
        source="email"
        label={translate("savia.users.fields.email", { _: "Correo" })}
        className="hidden md:table-cell"
        headerClassName="hidden md:table-cell"
      />
      <DataTable.Col
        source="platformAdmin"
        label={t("Acceso")}
        className="hidden lg:table-cell"
        headerClassName="hidden lg:table-cell"
        render={(record) => <UserAccessSummary record={record as UserRecord} />}
      />
      <DataTable.Col
        source="twoFactorEnabled"
        label="MFA"
        className="hidden xl:table-cell"
        headerClassName="hidden xl:table-cell"
        render={(record) =>
          record.deletionPending ? (
            "—"
          ) : (
            <MfaStatus enabled={record.twoFactorEnabled} />
          )
        }
      />
      <DataTable.Col
        source="isActive"
        label={translate("savia.users.fields.status", { _: "Estado" })}
        className="hidden sm:table-cell"
        headerClassName="hidden sm:table-cell"
        render={(record) => (
          <UserStatus
            active={record.isActive}
            deletionPending={record.deletionPending}
          />
        )}
      />
      <DataTable.Col
        label={translate("savia.tenants.table.actions", { _: "Acciones" })}
        disableSort
        className="w-px whitespace-nowrap"
        headerClassName="w-px text-right"
        render={(record) => (
          <div
            className="flex justify-end gap-2 py-1 [&_button]:max-sm:size-11"
            onClick={(event) => event.stopPropagation()}
          >
            <ShowButton iconOnly />
            {!record.deletionPending && <EditButton iconOnly />}
            <UserDeleteButton iconOnly redirectTo={false} />
          </div>
        )}
      />
    </DataTable>
  );
}

export function UserCreate() {
  const translate = useTranslate();
  const t = useMessages(settingsMessages);
  const notify = useNotify();
  const queryClient = useQueryClient();
  const [passwordError, setPasswordError] = useState<{ message: string }>();
  const [submissionError, setSubmissionError] =
    useState<keyof typeof settingsMessages>();
  const { permissions, isPending } = usePermissions<AuthPermissions>();
  const scope = userCreateScope(permissions);
  const { platformCanEdit, tenantId } = scope;
  if (isPending)
    return <p role="status">{translate("savia.users.loadingPermissions")}</p>;
  if (!platformCanEdit && tenantId === undefined)
    return <p role="alert">{translate("savia.users.tenantAdminRequired")}</p>;

  return (
    <Create
      title={translate("savia.users.newUser", { _: "Nuevo usuario" })}
      mutationOptions={{
        onMutate: () => {
          setPasswordError(undefined);
          setSubmissionError(undefined);
        },
        onError: (error) => {
          const { code } = asApiErrorLike(error);
          if (code === "USER_TEMPORARY_PASSWORD_INVALID") {
            setPasswordError({
              message: t(
                "La contraseña temporal debe tener entre 12 y 128 caracteres.",
              ),
            });
            return;
          }
          if (code === "TENANT_ACTIVE_USER_LIMIT_REACHED") {
            setSubmissionError(userUpdateErrorMessage(error));
            void queryClient.invalidateQueries({
              queryKey: ["tenant-user-capacity"],
            });
            return;
          }
          if (
            code === "COMMERCIAL_TENANT_REQUIRED" ||
            code === "TENANT_NOT_FOUND"
          ) {
            setSubmissionError(userUpdateErrorMessage(error));
            void queryClient.invalidateQueries({ queryKey: ["tenants"] });
            return;
          }
          notify(
            typeof error === "string"
              ? error
              : error instanceof Error
                ? error.message
                : translate("ra.notification.http_error"),
            { type: "error" },
          );
        },
      }}
    >
      <SimpleForm
        className="max-w-5xl gap-8"
        defaultValues={scope.defaultValues}
      >
        <UserIdentityFields />
        <UserInitialAccessFields
          tenantAdminTenantId={tenantId}
          platformCanEdit={platformCanEdit}
          passwordError={passwordError}
        />
        <UserCreateCapacity
          tenantAdminTenantId={tenantId}
          platformCanEdit={platformCanEdit}
        />
        {submissionError && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{t(submissionError)}</AlertDescription>
          </Alert>
        )}
      </SimpleForm>
    </Create>
  );
}

function UserCreateCapacity({
  tenantAdminTenantId: ownTenantId,
  platformCanEdit,
}: {
  tenantAdminTenantId?: number;
  platformCanEdit: boolean;
}) {
  const [formTenantId, platformAdmin] = useWatch({
    name: ["tenantId", "platformAdmin"],
  });
  if (platformCanEdit && platformAdmin) return null;
  const parsedTenantId = Number(formTenantId);
  return (
    <TenantUserCapacity
      tenantId={
        platformCanEdit
          ? Number.isSafeInteger(parsedTenantId) && parsedTenantId > 0
            ? parsedTenantId
            : undefined
          : ownTenantId
      }
      platformCanEdit={platformCanEdit}
    />
  );
}

const userEditResetOptions = { keepDirtyValues: true };

type UserSubmissionError = {
  userId: string;
  message: keyof typeof settingsMessages;
};

function userUpdateErrorMessage(error: unknown): keyof typeof settingsMessages {
  const { code } = asApiErrorLike(error);
  if (code === "TENANT_ACTIVE_USER_LIMIT_REACHED")
    return "El tenant seleccionado alcanzó su límite de usuarios activos.";
  if (
    code === "COMMERCIAL_MEMBERSHIP_REQUIRED" ||
    code === "COMMERCIAL_TENANT_REQUIRED" ||
    code === "TENANT_NOT_FOUND"
  )
    return "Selecciona un tenant comercial activo y un rol.";
  if (code === "REQUEST_TIMEOUT" || isOfflineError(error))
    return "No se pudo confirmar el guardado. Verifica el acceso actual del usuario antes de reintentar.";
  return "No fue posible guardar los cambios del usuario.";
}

export function UserEdit() {
  const translate = useTranslate();
  const { platformCanEdit, subscription } = useUserRealtimeScope();
  const [submissionError, setSubmissionError] = useState<UserSubmissionError>();
  return (
    <Edit
      title={<UserEditTitle />}
      actions={<UserEditActions />}
      mutationMode="pessimistic"
      mutationOptions={{
        onMutate: () => setSubmissionError(undefined),
        onError: (error, { id }) =>
          setSubmissionError({
            userId: String(id),
            message: userUpdateErrorMessage(error),
          }),
      }}
    >
      <UserEditForm platformCanEdit={platformCanEdit}>
        <ResourceEditSync resource="users" subscription={subscription} />
        <UserSubmissionAlert error={submissionError} />
        <Tabs defaultValue="identity" className="w-full gap-6">
          <div className="max-w-full overflow-x-auto">
            <TabsList
              aria-label={translate("savia.users.tabs.ariaLabel", {
                _: "Configuración del usuario",
              })}
              className="[&>[role=tab]]:min-h-11"
            >
              <TabsTrigger value="identity">
                {translate("savia.users.tabs.identity", { _: "Identidad" })}
              </TabsTrigger>
              {platformCanEdit && (
                <>
                  <TabsTrigger value="access">
                    {translate("savia.users.tabs.access", {
                      _: "Acceso de plataforma",
                    })}
                  </TabsTrigger>
                  <TabsTrigger value="tenant">
                    {translate("savia.users.tabs.tenant", {
                      _: "Tenant asignado",
                    })}
                  </TabsTrigger>
                </>
              )}
            </TabsList>
          </div>
          <TabsContent
            value="identity"
            forceMount
            className="data-[state=inactive]:hidden"
          >
            <UserIdentityFields edit />
          </TabsContent>
          {platformCanEdit && (
            <>
              <TabsContent
                value="access"
                forceMount
                className="data-[state=inactive]:hidden"
              >
                <UserPlatformAccessFields />
              </TabsContent>
              <TabsContent
                value="tenant"
                forceMount
                className="data-[state=inactive]:hidden"
              >
                <UserMembershipEditor />
              </TabsContent>
            </>
          )}
        </Tabs>
      </UserEditForm>
    </Edit>
  );
}

function UserEditForm({
  platformCanEdit,
  children,
}: {
  platformCanEdit: boolean;
  children: ReactNode;
}) {
  const record = useRecordContext<UserRecord>();
  const { save } = useSaveContext();
  if (record?.deletionPending)
    return <UserDeletionPending email={record.email} />;
  const buildUpdate = platformCanEdit
    ? platformAdminUserUpdateData
    : tenantAdminUserUpdateData;
  const getChanges = (values: UserFormData) =>
    buildUpdate(values, { previousData: record });
  return (
    <SimpleForm
      className="max-w-5xl gap-6"
      resetOptions={userEditResetOptions}
      toolbar={<UserEditToolbar getChanges={getChanges} />}
      onSubmit={async (values: UserFormData) => {
        const changes = getChanges(values);
        if (Object.keys(changes).length > 0) return save?.(changes);
      }}
    >
      {children}
    </SimpleForm>
  );
}

function UserEditToolbar({
  getChanges,
}: {
  getChanges: (values: UserFormData) => UserFormData;
}) {
  const values = useWatch<UserFormData>();
  return (
    <FormToolbar>
      <div className="flex flex-row justify-end gap-2">
        <CancelButton />
        <SaveButton disabled={Object.keys(getChanges(values)).length === 0} />
      </div>
    </FormToolbar>
  );
}

function UserSubmissionAlert({
  error,
  className,
}: {
  error?: UserSubmissionError;
  className?: string;
}) {
  const record = useRecordContext<UserRecord>();
  const t = useMessages(settingsMessages);
  if (!error || record?.id !== error.userId) return null;
  return (
    <Alert variant="destructive" className={className}>
      <CircleAlert aria-hidden="true" />
      <AlertDescription>{t(error.message)}</AlertDescription>
    </Alert>
  );
}

function UserEditTitle() {
  const { record } = useEditContext<UserRecord>();
  const translate = useTranslate();
  return (
    <>
      <span className="block text-sm font-medium text-muted-foreground">
        {translate("savia.users.editUser", { _: "Editar usuario" })}
      </span>
      <span className="mt-1 block">{record?.displayName}</span>
    </>
  );
}

function UserEditActions() {
  const translate = useTranslate();
  const { record } = useEditContext<UserRecord>();
  if (record?.deletionPending) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2 [&_button]:max-sm:size-11 [&_a]:max-sm:min-h-11 [&_a]:max-sm:min-w-11">
      <ShowButton
        iconOnly
        label={translate("savia.users.actions.showCard", { _: "Ver ficha" })}
      />
      <UserDeleteButton
        iconOnly
        label={translate("savia.users.actions.delete", {
          _: "Eliminar usuario",
        })}
      />
    </div>
  );
}

export function UserShow() {
  const { subscription } = useUserRealtimeScope();
  return (
    <Show title={<UserShowTitle />} actions={<UserShowActions />}>
      <ResourceReadSync resource="users" subscription={subscription} />
      <UserShowContent />
    </Show>
  );
}

function UserShowTitle() {
  const { record } = useShowContext<UserRecord>();
  const translate = useTranslate();
  return (
    <>
      <span className="block text-sm font-medium text-muted-foreground">
        {translate("savia.users.userDetails", { _: "Ficha de usuario" })}
      </span>
      <span className="mt-1 block">{record?.displayName}</span>
    </>
  );
}

function UserShowActions() {
  const translate = useTranslate();
  const { record } = useShowContext<UserRecord>();
  if (record?.deletionPending) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2 [&_button]:max-sm:size-11 [&_a]:max-sm:min-h-11 [&_a]:max-sm:min-w-11">
      <EditButton
        iconOnly
        label={translate("savia.users.editUser", { _: "Editar usuario" })}
      />
      <UserDeleteButton
        iconOnly
        label={translate("savia.users.actions.delete", {
          _: "Eliminar usuario",
        })}
      />
    </div>
  );
}

function UserDeletionPending({ email }: { email: string }) {
  const t = useMessages(settingsMessages);
  return (
    <Alert className="max-w-xl">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{t("Eliminación pendiente")}</AlertTitle>
      <AlertDescription>
        <p className="wrap-anywhere font-medium text-foreground">{email}</p>
        <p>
          {t(
            "La cuenta está desactivada. Reintenta para completar la eliminación.",
          )}
        </p>
        <div className="mt-2">
          <UserDeleteButton />
        </div>
      </AlertDescription>
    </Alert>
  );
}

function UserShowContent() {
  const t = useMessages(settingsMessages);
  const { record } = useShowContext<UserRecord>();
  const translate = useTranslate();
  if (!record) return null;
  if (record.deletionPending)
    return <UserDeletionPending email={record.email} />;

  return (
    <div className="max-w-5xl space-y-5">
      <UserSection
        title={translate("savia.users.sections.identity", { _: "Identidad" })}
        description={translate("savia.users.sections.identityDetailsDesc", {
          _: "Datos que identifican la cuenta y su acceso a Savia.",
        })}
      >
        <UserReadOnlyField
          label={translate("savia.users.fields.name", { _: "Nombre" })}
          value={record.displayName}
        />
        <UserReadOnlyField
          label={translate("savia.users.fields.email", { _: "Correo" })}
          value={
            <span className="grid gap-1">
              {record.email}
              <span className="text-sm text-muted-foreground">
                <EmailVerificationStatus verified={record.emailVerified} />
              </span>
            </span>
          }
        />
        <UserReadOnlyField
          label={translate("savia.users.fields.platformRole", {
            _: "Rol de plataforma",
          })}
          value={
            record.platformAdmin
              ? translate("savia.users.fields.platformAdmin", {
                  _: "Administrador de plataforma",
                })
              : translate("savia.users.fields.noGlobalAccess", {
                  _: "Sin acceso global",
                })
          }
        />
        <UserReadOnlyField
          label={translate("savia.users.fields.status", { _: "Estado" })}
          value={<UserStatus active={record.isActive} />}
        />
      </UserSection>
      <UserSection
        title={translate("savia.users.sections.assignedTenant", {
          _: "Tenant asignado",
        })}
        description={translate("savia.users.sections.assignedRoleDesc", {
          _: "El rol se aplica dentro del tenant asignado.",
        })}
      >
        {record.memberships.length === 0 ? (
          <p className="text-sm text-muted-foreground md:col-span-2">
            {translate("savia.users.noTenantAssigned", {
              _: "No tiene tenant asignado.",
            })}
          </p>
        ) : (
          record.memberships
            .slice(0, 1)
            .map((membership) => (
              <UserReadOnlyField
                key={membership.id}
                label={t("Tenant #%{value}", { value: membership.tenantId })}
                value={tenantRoleName(membership.role, translate)}
              />
            ))
        )}
      </UserSection>
      <UserSection
        title={translate("savia.users.sections.security", { _: "Seguridad" })}
        description={translate("savia.users.sections.securityDesc", {
          _: "La MFA se gestiona desde la cuenta del usuario; el administrador puede ver su estado.",
        })}
      >
        <UserReadOnlyField
          label={translate("savia.users.fields.mfa", {
            _: "Autenticación multifactor",
          })}
          value={<MfaStatus enabled={record.twoFactorEnabled} />}
        />
        <UserReadOnlyField
          label={translate("savia.users.fields.sessions", { _: "Sesiones" })}
          value={translate("savia.users.fields.sessionsHelper", {
            _: "Puedes cerrarlas desde las acciones de cuenta.",
          })}
        />
      </UserSection>
      <UserAccountActions record={record} />
    </div>
  );
}

function UserIdentityFields({ edit = false }: { edit?: boolean }) {
  const translate = useTranslate();
  const record = useRecordContext<UserRecord>();
  return (
    <UserSection
      title={translate("savia.users.sections.identity", { _: "Identidad" })}
      description={
        edit
          ? translate("savia.users.sections.identityEditDesc", {
              _: "Actualiza el nombre de la persona. El correo se conserva como identificador de acceso.",
            })
          : translate("savia.users.sections.identityCreateDesc", {
              _: "Puedes enviar un enlace seguro o definir una contraseña temporal para el primer ingreso.",
            })
      }
    >
      <TextInput
        source="firstName"
        label={translate("savia.users.fields.firstName", { _: "Nombres" })}
        validate={!edit || record?.firstName ? requiredNameField : undefined}
      />
      <TextInput
        source="lastName"
        label={translate("savia.users.fields.lastName", { _: "Apellidos" })}
        validate={!edit || record?.lastName ? requiredNameField : undefined}
      />
      <TextInput
        source="email"
        label={translate("savia.users.fields.email", { _: "Correo" })}
        type="email"
        readOnly={edit}
        validate={edit ? undefined : requiredField}
        className="md:col-span-2"
      />
      <EmailVerificationField />
    </UserSection>
  );
}

function UserInitialAccessFields({
  tenantAdminTenantId: ownTenantId,
  platformCanEdit,
  passwordError,
}: {
  tenantAdminTenantId?: number;
  platformCanEdit: boolean;
  passwordError?: { message: string };
}) {
  const translate = useTranslate();
  const platformAdmin = useWatch({ name: "platformAdmin" });
  const { setError } = useFormContext<UserFormData>();
  useEffect(() => {
    if (!passwordError) return;
    setError(
      "temporaryPassword",
      { type: "server", message: passwordError.message },
      { shouldFocus: true },
    );
  }, [passwordError, setError]);
  return (
    <UserSection
      title={translate("savia.users.sections.initialAccess", {
        _: "Acceso inicial",
      })}
      description={
        platformCanEdit
          ? translate("savia.users.sections.initialAccessDesc", {
              _: "Asigna el tenant comercial del usuario o conviértelo en administrador de plataforma.",
            })
          : translate("savia.users.sections.tenantInitialAccessDesc", {
              _: "El usuario se creará en tu tenant. Puedes elegir su rol dentro del tenant.",
            })
      }
    >
      <TextInput
        source="temporaryPassword"
        label={translate("savia.users.fields.temporaryPassword", {
          _: "Contraseña temporal",
        })}
        type="password"
        autoComplete="new-password"
        validate={temporaryPasswordValidators}
        helperText={translate("savia.tenants.fields.temporaryPasswordHelper", {
          _: "Si la ingresas, usa de 12 a 128 caracteres. Si la dejas vacía, se enviará un enlace para definirla.",
        })}
        className="md:col-span-2"
      />
      {platformCanEdit ? (
        <>
          <BooleanInput
            source="platformAdmin"
            label={translate("savia.users.fields.platformAdmin", {
              _: "Administrador de plataforma",
            })}
            helperText={translate("savia.users.fields.platformAdminHelper", {
              _: "Puede administrar usuarios, roles y toda la operación.",
            })}
            className="md:col-span-2"
          />
          {!platformAdmin && (
            <CommercialTenantInput
              label={translate("savia.users.fields.commercialTenant", {
                _: "Tenant comercial",
              })}
            />
          )}
        </>
      ) : (
        <TextInput
          source="tenantId"
          type="number"
          readOnly
          label={translate("savia.users.fields.tenant", { _: "Tenant" })}
          helperText={translate("savia.users.fields.fixedTenantHelper", {
            id: ownTenantId,
            _: `This user will be assigned to tenant #${ownTenantId}.`,
          })}
        />
      )}
      {(!platformCanEdit || !platformAdmin) && (
        <SelectInput
          source="agencyRole"
          label={translate("savia.users.fields.tenantRole", {
            _: "Rol en el tenant",
          })}
          choices={getTenantRoleChoices(translate)}
        />
      )}
      <UserAccessRoles />
    </UserSection>
  );
}

function UserPlatformAccessFields() {
  const translate = useTranslate();
  const { record } = useEditContext<UserRecord>();
  const platformAdmin = useWatch({ name: "platformAdmin" });
  const demoting = record?.platformAdmin && platformAdmin === false;
  return (
    <UserSection
      title={translate("savia.users.sections.platformAccess", {
        _: "Acceso de plataforma",
      })}
      description={translate("savia.users.sections.platformAccessDesc", {
        _: "Los administradores de plataforma pueden gestionar toda Savia.",
      })}
    >
      <BooleanInput
        source="platformAdmin"
        label={translate("savia.users.fields.platformAdmin", {
          _: "Administrador de plataforma",
        })}
        helperText={translate("savia.users.fields.platformAdminRemoveHelper", {
          _: "Al retirarlo, selecciona abajo el tenant comercial y el rol que conservará el usuario.",
        })}
        className="md:col-span-2"
      />
      <ReferenceInput
        source="tenantId"
        reference="tenants"
        perPage={100}
        filter={{ kind: "commercial", isActive: true }}
      >
        <AutocompleteInput
          label={translate("savia.users.fields.commercialTenantRemove", {
            _: "Tenant comercial al retirar acceso global",
          })}
          validate={demoting ? requiredField : undefined}
        />
      </ReferenceInput>
      <SelectInput
        source="agencyRole"
        label={translate("savia.users.fields.tenantRoleRemove", {
          _: "Rol al retirar acceso global",
        })}
        choices={getTenantRoleChoices(translate)}
        validate={demoting ? requiredField : undefined}
      />
    </UserSection>
  );
}

function CommercialTenantInput({ label }: { label: string }) {
  return (
    <ReferenceInput
      source="tenantId"
      reference="tenants"
      perPage={100}
      filter={{ kind: "commercial", isActive: true }}
    >
      <CommercialTenantChoiceInput label={label} />
    </ReferenceInput>
  );
}

function CommercialTenantChoiceInput({ label }: { label: string }) {
  const {
    allChoices = [],
    filterValues,
    hasNextPage,
    isFetching,
  } = useChoicesContext();
  const tenants = allChoices as TenantRecord[];
  const { register, setValue } = useFormContext();
  const tenantId = useWatch({ name: "tenantId" });
  const onlyTenant =
    !filterValues?.q && !hasNextPage && tenants.length === 1
      ? tenants[0]
      : undefined;
  const useOnlyTenant =
    onlyTenant &&
    (tenantId == null ||
      tenantId === "" ||
      String(tenantId) === String(onlyTenant.id));

  useEffect(() => {
    if (useOnlyTenant && !isFetching && (tenantId == null || tenantId === "")) {
      setValue("tenantId", onlyTenant.id, {
        shouldDirty: false,
        shouldTouch: false,
      });
    }
  }, [isFetching, onlyTenant, setValue, tenantId, useOnlyTenant]);

  if (useOnlyTenant && !isFetching) {
    return (
      <input type="hidden" {...register("tenantId", { valueAsNumber: true })} />
    );
  }

  return <AutocompleteInput label={label} validate={requiredField} />;
}

function TenantTransferPicker({
  label,
  tenants,
  selected,
  onSelect,
  disabled,
}: {
  label: string;
  tenants: TenantRecord[];
  selected?: TenantRecord;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const t = useMessages(settingsMessages);
  const translate = useTranslate();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className="w-full min-w-0 justify-between gap-2 font-normal"
        >
          <span className="truncate">
            {selected?.name ??
              translate("savia.users.fields.selectTenantPlaceholder", {
                _: "Selecciona un tenant",
              })}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
      >
        <Command
          filter={(_id, search, keywords = []) => {
            const term = tenantSearchText(search);
            return keywords.some((value) => value.includes(term)) ? 1 : 0;
          }}
        >
          <CommandInput
            placeholder={translate("ra.action.search", { _: "Buscar" })}
          />
          <CommandList>
            <CommandEmpty>{t("No matching item found.")}</CommandEmpty>
            {tenants.map((tenant) => (
              <CommandItem
                key={tenant.id}
                value={String(tenant.id)}
                keywords={[
                  tenantSearchText(tenant.name),
                  tenantSearchText(tenant.idSlug),
                ]}
                onSelect={(id) => {
                  onSelect(id);
                  setOpen(false);
                }}
              >
                {tenant.name}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function UserMembershipEditor() {
  const t = useMessages(settingsMessages);
  const { record } = useEditContext<UserRecord>();
  const dataProvider = useDataProvider() as IdentityUserDataProvider;
  const notify = useNotify();
  const refresh = useRefresh();
  const translate = useTranslate();
  const [tenantId, setTenantId] = useState("");
  const [role, setRole] = useState<AgencyAccessRole>("viewer");
  const [pending, setPending] = useState(false);
  const [transferError, setTransferError] = useState<UserSubmissionError>();
  const { data: tenants = [] } = useGetList<TenantRecord>("tenants", {
    // The tenants endpoint already delivers the full authorized catalog.
    pagination: { page: 1, perPage: Number.MAX_SAFE_INTEGER },
    sort: { field: "name", order: "ASC" },
    filter: { kind: "commercial", isActive: true },
  });
  const membership = record?.memberships[0];
  const assignedTenantId = membership ? String(membership.tenantId) : "";
  const savedRole = membership?.role;
  const onlyTenant = tenants.length === 1 ? tenants[0] : undefined;
  const fixedTenant =
    onlyTenant &&
    (!assignedTenantId || assignedTenantId === String(onlyTenant.id))
      ? onlyTenant
      : undefined;
  const selectedTenant =
    fixedTenant ?? tenants.find((tenant) => String(tenant.id) === tenantId);
  const destinationId = Number(selectedTenant?.id);
  const canTransfer =
    !pending && Number.isSafeInteger(destinationId) && destinationId > 0;

  useEffect(() => {
    setRole(
      savedRole === "agency_admin" ? "tenant_admin" : (savedRole ?? "viewer"),
    );
    setTenantId(assignedTenantId);
  }, [record?.id, savedRole, assignedTenantId]);

  if (!record) return null;

  const transferMembership = async () => {
    if (!canTransfer) return;
    setTransferError(undefined);
    setPending(true);
    try {
      await dataProvider.grantMembership(record.id, {
        tenantId: destinationId,
        role,
      });
      notify(
        translate("savia.users.notifications.tenantUpdated", {
          _: "Asignación de tenant actualizada.",
        }),
        { type: "success" },
      );
      refresh();
    } catch (error) {
      setTransferError({
        userId: record.id,
        message: userUpdateErrorMessage(error),
      });
    } finally {
      setPending(false);
    }
  };

  const roleChoices = getTenantRoleChoices(translate);
  const tenantLabel = translate("savia.users.fields.tenant", { _: "Tenant" });

  return (
    <UserSection
      title={translate("savia.users.sections.assignedTenant", {
        _: "Tenant asignado",
      })}
      description={translate("savia.users.sections.assignedTenantDesc", {
        _: "Cada usuario pertenece a un tenant. Usa la transferencia para cambiarlo sin dejarlo sin acceso.",
      })}
    >
      <div className="space-y-3 md:col-span-2">
        {record.memberships.slice(0, 1).map((membership) => (
          <div
            key={membership.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
          >
            <div className="text-sm">
              <span className="font-medium">
                {t("Tenant #%{value}", { value: membership.tenantId })}
              </span>
              <span className="ml-2 text-muted-foreground">
                {tenantRoleName(membership.role, translate)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 rounded-lg border p-3 md:col-span-2 md:grid-cols-[1fr_220px_auto] md:items-end">
        <label className="grid gap-2 text-sm font-medium">
          {tenantLabel}
          {fixedTenant ? (
            <span className="rounded-md border px-3 py-2 font-normal">
              {fixedTenant.name}
            </span>
          ) : (
            <TenantTransferPicker
              label={tenantLabel}
              tenants={tenants}
              selected={selectedTenant}
              onSelect={setTenantId}
              disabled={pending}
            />
          )}
        </label>
        <label className="grid gap-2 text-sm font-medium">
          {translate("savia.users.fields.role", { _: "Rol" })}
          <Select
            value={role}
            disabled={pending}
            onValueChange={(value) => {
              const choice = roleChoices.find(
                (candidate) => candidate.id === value,
              );
              if (choice) setRole(choice.id);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roleChoices.map((choice) => (
                <SelectItem key={choice.id} value={choice.id}>
                  {choice.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button
          type="button"
          disabled={!canTransfer}
          onClick={() => void transferMembership()}
          className="max-sm:size-11 max-sm:p-0 max-sm:has-[>svg]:px-0"
        >
          <Plus className="size-4" />
          <span className="sr-only sm:not-sr-only">
            {record.memberships.length
              ? translate("savia.users.actions.transfer", {
                  _: "Transferir usuario",
                })
              : translate("savia.users.actions.assignTenant", {
                  _: "Asignar tenant",
                })}
          </span>
        </Button>
      </div>
      <UserSubmissionAlert error={transferError} className="md:col-span-2" />
    </UserSection>
  );
}

function UserAccountActions({ record }: { record: UserRecord }) {
  const dataProvider = useDataProvider() as IdentityUserDataProvider;
  const notify = useNotify();
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  const translate = useTranslate();
  const [pending, setPending] = useState<string | null>(null);

  const run = async (
    key: string,
    action: () => Promise<void>,
    message: string,
  ) => {
    setPending(key);
    try {
      await action();
      if (key === "status") {
        void queryClient.invalidateQueries({
          queryKey: ["tenant-user-capacity"],
        });
      }
      notify(message, { type: "success" });
      refresh();
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : translate("savia.users.notifications.actionError", {
              _: "No fue posible completar la acción.",
            }),
        {
          type: "error",
        },
      );
    } finally {
      setPending(null);
    }
  };

  const suspended = !record.isActive || record.isBanned;
  return (
    <UserSection
      title={translate("savia.users.sections.accountActions", {
        _: "Acciones de cuenta",
      })}
      description={translate("savia.users.sections.accountActionsDesc", {
        _: "Estas acciones no modifican la contraseña ni desactivan MFA de otra persona.",
      })}
    >
      <div className="flex flex-wrap gap-2 md:col-span-2">
        <Button
          type="button"
          variant="outline"
          className="max-sm:size-11 max-sm:p-0 max-sm:has-[>svg]:px-0"
          disabled={pending !== null}
          onClick={() =>
            void run(
              "reset",
              () => dataProvider.sendPasswordReset(record.id),
              translate("savia.users.notifications.passwordResetSent", {
                _: "Enlace de restablecimiento enviado.",
              }),
            )
          }
        >
          <KeyRound className="size-4" />
          <span className="sr-only sm:not-sr-only">
            {translate("savia.users.actions.resendPassword", {
              _: "Reenviar contraseña",
            })}
          </span>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="max-sm:size-11 max-sm:p-0 max-sm:has-[>svg]:px-0"
          disabled={pending !== null}
          onClick={() =>
            void run(
              "sessions",
              () => dataProvider.revokeSessions(record.id),
              translate("savia.users.notifications.sessionsRevoked", {
                _: "Sesiones cerradas.",
              }),
            )
          }
        >
          <LogOut className="size-4" />
          <span className="sr-only sm:not-sr-only">
            {translate("savia.users.actions.revokeSessions", {
              _: "Cerrar sesiones",
            })}
          </span>
        </Button>
        <Button
          type="button"
          variant={suspended ? "outline" : "destructive"}
          className="max-sm:size-11 max-sm:p-0 max-sm:has-[>svg]:px-0"
          disabled={pending !== null}
          onClick={() =>
            void run(
              "status",
              () =>
                suspended
                  ? dataProvider.reactivate(record.id)
                  : dataProvider.suspend(record.id),
              suspended
                ? translate("savia.users.notifications.userReactivated", {
                    _: "Usuario reactivado.",
                  })
                : translate("savia.users.notifications.userSuspended", {
                    _: "Usuario suspendido.",
                  }),
            )
          }
        >
          {suspended ? (
            <RotateCcw className="size-4" />
          ) : (
            <Ban className="size-4" />
          )}
          <span className="sr-only sm:not-sr-only">
            {suspended
              ? translate("savia.users.actions.reactivate", {
                  _: "Reactivar usuario",
                })
              : translate("savia.users.actions.suspend", {
                  _: "Suspender usuario",
                })}
          </span>
        </Button>
      </div>
    </UserSection>
  );
}

function UserSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6 grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}

function UserReadOnlyField({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value ?? "—"}</dd>
    </div>
  );
}

function useTenantName(tenantId: number | undefined) {
  const { data } = useGetOne<TenantRecord>(
    "tenants",
    { id: tenantId },
    { enabled: tenantId !== undefined },
  );
  return data && data.id === tenantId ? data.name?.trim() : undefined;
}

function UserAccessSummary({ record }: { record: UserRecord }) {
  const translate = useTranslate();
  const tenantName = useTenantName(
    record.platformAdmin ? undefined : record.memberships[0]?.tenantId,
  );
  if (record.platformAdmin)
    return (
      <Badge>
        {translate("savia.users.badges.platform", { _: "Plataforma" })}
      </Badge>
    );
  if (record.memberships.length === 0)
    return (
      <span className="text-muted-foreground">
        {translate("savia.users.badges.noAccess", { _: "Sin acceso" })}
      </span>
    );
  return <span>{tenantName || "—"}</span>;
}

function UserStatus({
  active,
  deletionPending,
}: {
  active: boolean;
  deletionPending?: boolean;
}) {
  const translate = useTranslate();
  const t = useMessages(settingsMessages);
  if (deletionPending)
    return <Badge variant="outline">{t("Eliminación pendiente")}</Badge>;
  return active ? (
    <Badge>{translate("savia.users.status.active", { _: "Activo" })}</Badge>
  ) : (
    <Badge variant="secondary">
      {translate("savia.users.status.suspended", { _: "Suspendido" })}
    </Badge>
  );
}

function MfaStatus({ enabled }: { enabled: boolean }) {
  const translate = useTranslate();
  return enabled ? (
    <span className="inline-flex items-center gap-1.5 text-sm text-primary">
      <ShieldCheck className="size-4" />{" "}
      {translate("savia.users.mfa.active", { _: "Activa" })}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <ShieldOff className="size-4" />{" "}
      {translate("savia.users.mfa.inactive", { _: "No activa" })}
    </span>
  );
}

function getTenantRoleChoices(
  translate: (key: string, options?: any) => string,
): { id: AgencyAccessRole; name: string }[] {
  return [
    {
      id: "tenant_admin",
      name: translate("savia.users.roles.tenant_admin", {
        _: "Administrador de tenant",
      }),
    },
    {
      id: "operator",
      name: translate("savia.users.roles.operator", { _: "Operador" }),
    },
    {
      id: "viewer",
      name: translate("savia.users.roles.viewer", { _: "Solo lectura" }),
    },
  ];
}

function tenantRoleName(
  role: AgencyAccessRole,
  translate?: (key: string, options?: any) => string,
): string {
  const normalizedRole = role === "agency_admin" ? "tenant_admin" : role;
  if (translate) {
    const key = `savia.users.roles.${normalizedRole}`;
    const fallback =
      tenantRoleChoices.find((choice) => choice.id === normalizedRole)?.name ??
      role;
    return translate(key, { _: fallback });
  }
  return (
    tenantRoleChoices.find((choice) => choice.id === normalizedRole)?.name ??
    role
  );
}
