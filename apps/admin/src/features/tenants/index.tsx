import { useEffect, useState } from "react";
import { z } from "zod";
import { useMessages } from "@/i18n/core";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { tenantSettingsMessages } from "./settings-messages";
import "@/features/service-credentials/service-credentials.css";
import { OfficeSettingsPanel } from "@/features/office-settings/office-settings-panel";
import { useAppServices } from "@/features/assistant/assistant-context";
import { TenantAccessUrl } from "@/features/tenant-branding/tenant-access-url";
import "@/features/tenant-branding/tenant-branding.css";
import { ResourceEditSync } from "@/realtime/resource-realtime";
import type { ResourceProps } from "ra-core";
import { EmailVerificationField } from "@/features/users/email-verification-field";
import {
  LinkBase,
  maxLength,
  minLength,
  required,
  useCreatePath,
  useRecordContext,
  useDelete,
  useEditContext,
  usePermissions,
  useRedirect,
  useRefresh,
  useSaveContext,
  useTranslate,
} from "ra-core";
import { TenantUserCapacity } from "@/features/users/tenant-user-capacity";
import { TenantPagesSearchSettingsPanel } from "@/features/tenant-pages-search/tenant-pages-search-settings-panel";
import { TenantApiKeysPanel } from "@/features/tenant-api-keys/tenant-api-keys";
import { TenantSignInLinks } from "@/features/tenant-sso/tenant-sign-in-links";
import { useFormContext, useWatch } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, CircleAlert, Trash2 } from "lucide-react";
import {
  AutocompleteInput,
  BooleanInput,
  CancelButton,
  Create,
  CreateButton,
  DataTable,
  Edit,
  EditButton,
  FormToolbar,
  List,
  RadioButtonGroupInput,
  ReferenceInput,
  SaveButton,
  SelectInput,
  SimpleForm,
  TextInput,
} from "@/components/admin";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { applyRealtimeListEvent } from "@/realtime/realtime-list";
import { useRealtimeTopics } from "@/realtime/use-realtime";
import type { UserRecord } from "@/api/identity-user-data-provider";
import type { TenantRecord } from "@/api/tenant-data-provider";
import { ApiClientError } from "@/api/api-client";
import type { AuthPermissions } from "@/auth/auth-session";
import { isOfflineError } from "@/offline/offline-error";

const tenantDeletionResultUnknown =
  "Deletion did not return a result. Refresh the tenant list to check its status before retrying.";

function tenantCascadeDeleteErrorMessage(
  error: unknown,
): keyof typeof tenantSettingsMessages {
  const code = tenantMutationErrorCode(error);
  const candidate =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};

  if (code === "TENANT_CLEANUP_UNAVAILABLE")
    return "Some cleanup services are unavailable. Refresh the tenant and retry the deletion.";
  if (code === "TENANT_FILE_CLEANUP_UNAVAILABLE")
    return "Tenant file cleanup failed. The tenant is inactive. Retry the deletion.";
  if (code === "TENANT_AUTH_CLEANUP_UNAVAILABLE")
    return "Tenant authentication settings could not be removed. The tenant is inactive. Retry the deletion.";
  if (code === "TENANT_BRANDING_UPLOAD_IN_PROGRESS")
    return "A tenant image is still uploading. Wait for it to finish before retrying deletion.";
  if (code === "TENANT_CONFIRMATION_REQUIRED" || candidate.status === 409)
    return "The tenant name changed or did not match. Refresh the tenant and confirm using its current name.";
  if (code === "TENANT_NOT_FOUND" || candidate.status === 404)
    return "This tenant no longer exists. Return to the tenant list and refresh it.";
  if (
    code === "REQUEST_TIMEOUT" ||
    candidate.status === 408 ||
    isOfflineError(error)
  )
    return tenantDeletionResultUnknown;
  return "Could not delete the tenant. Retry or contact a platform administrator.";
}

function tenantMutationErrorCode(error: unknown): string | undefined {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
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
    (typeof nestedRecord?.code === "string" ? nestedRecord.code : undefined);
  return code;
}

const temporaryPasswordSource = "initialUser.temporaryPassword";

type TenantCreateSubmissionError = {
  message: keyof typeof tenantSettingsMessages;
  field?: typeof temporaryPasswordSource;
};

function tenantCreateErrorMessage(
  error: unknown,
  code: string | undefined,
): keyof typeof tenantSettingsMessages {
  switch (code) {
    case "VERIFICATION_EMAIL_UNAVAILABLE":
      return "Verification email could not be sent. Check email delivery and try again.";
    case "PASSWORD_RESET_EMAIL_UNAVAILABLE":
      return "The password setup email could not be sent. Use a temporary password or check email delivery.";
    case "IDENTITY_EMAIL_CONFLICT":
      return "An account already uses this email. Choose an existing user or use a different email.";
    case "USER_NOT_FOUND":
      return "This user is unavailable. Choose another active user.";
    case "TENANT_EXISTING_USER_REQUIRED":
      return "Select the existing user to transfer.";
    case "TENANT_TEMPORARY_PASSWORD_INVALID":
      return "The temporary password must contain 12 to 128 characters.";
    case "TENANT_CONFLICT": {
      const details =
        error instanceof ApiClientError
          ? (error.details as
              { error?: { reason?: unknown } } | null | undefined)
          : undefined;
      if (details?.error?.reason === "LAST_ACTIVE_MEMBER")
        return "This user is the last active member of their organization. Add another member there before transferring them.";
      if (details?.error?.reason === "PLATFORM_ADMIN")
        return "This user is a platform administrator. Revoke that role before transferring them.";
      break;
    }
    case "REQUEST_TIMEOUT":
      return "The request timed out. Check the tenant list before trying again.";
  }
  return "Could not create the tenant. Review the information and try again.";
}

function requiredName(max: number) {
  const validateRequired = required();
  const validateLength = maxLength(max);
  return Object.assign(
    (value: string | null | undefined, values: unknown) => {
      const trimmed = value?.trim();
      return (
        validateRequired(trimmed, values) ?? validateLength(trimmed, values)
      );
    },
    { isRequired: true },
  );
}

const validateTenantName = requiredName(200);
const validateAdminName = requiredName(100);
const adminEmailSchema = z.email();
const validateAdminEmail = [
  required(),
  (value: unknown) =>
    adminEmailSchema.safeParse(value).success
      ? undefined
      : "ra.validation.email",
];

function TenantFields() {
  const translate = useTranslate();
  return (
    <>
      <TextInput
        source="name"
        label={translate("savia.tenants.fields.name", {
          _: "Nombre del tenant",
        })}
        validate={validateTenantName}
      />
      <p className="text-sm text-muted-foreground md:col-span-2">
        {translate("savia.tenants.fields.urlHelper", {
          _: "La URL del tenant se asigna automáticamente a partir de su nombre y no cambia al renombrarlo.",
        })}
      </p>
      <BooleanInput
        source="isActive"
        label={translate("savia.tenants.fields.isActive", {
          _: "Activo",
        })}
        helperText={translate("savia.tenants.fields.isActiveHelper", {
          _: "Desactivar el tenant suspende el acceso de sus miembros.",
        })}
      />
    </>
  );
}

function InitialTenantUserFields({
  submissionError,
}: {
  submissionError?: TenantCreateSubmissionError;
}) {
  const translate = useTranslate();
  const t = useMessages(tenantSettingsMessages);
  const { getValues, setError } = useFormContext();
  const memberMode = useWatch({ name: "memberMode" }) ?? "new";

  useEffect(() => {
    if (!submissionError?.field || getValues("memberMode") === "existing")
      return;
    setError(
      submissionError.field,
      { type: "server", message: t(submissionError.message) },
      { shouldFocus: true },
    );
  }, [getValues, setError, submissionError, t]);

  return (
    <>
      <RadioButtonGroupInput
        source="memberMode"
        label={translate("savia.tenants.fields.memberMode", {
          _: "Primer administrador",
        })}
        choices={[
          {
            id: "new",
            name: translate("savia.tenants.fields.memberModeNew", {
              _: "Crear usuario nuevo",
            }),
          },
          {
            id: "existing",
            name: translate("savia.tenants.fields.memberModeExisting", {
              _: "Transferir usuario existente",
            }),
          },
        ]}
        row
      />
      {memberMode === "existing" ? (
        <ExistingTenantMemberFields />
      ) : (
        <>
          <TextInput
            source="initialUser.email"
            label={translate("savia.tenants.fields.initialAdminEmail", {
              _: "Correo del primer administrador",
            })}
            type="email"
            validate={validateAdminEmail}
          />
          <TextInput
            source="initialUser.firstName"
            label={translate("savia.tenants.fields.initialAdminFirstName", {
              _: "Nombres del primer administrador",
            })}
            validate={validateAdminName}
          />
          <TextInput
            source="initialUser.lastName"
            label={translate("savia.tenants.fields.initialAdminLastName", {
              _: "Apellidos del primer administrador",
            })}
            validate={validateAdminName}
          />
          <TextInput
            source={temporaryPasswordSource}
            label={translate("savia.tenants.fields.temporaryPassword", {
              _: "Contraseña temporal",
            })}
            type="password"
            validate={[minLength(12), maxLength(128)]}
            helperText={translate(
              "savia.tenants.fields.temporaryPasswordHelper",
              {
                _: "Si la ingresas, usa de 12 a 128 caracteres. Si la dejas vacía, se enviará un enlace para definirla.",
              },
            )}
          />
          <EmailVerificationField source="initialUser.emailVerified" />
        </>
      )}
      {submissionError &&
        (!submissionError.field || memberMode === "existing") && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>{t(submissionError.message)}</AlertDescription>
          </Alert>
        )}
    </>
  );
}

function tenantMemberLabel(user: UserRecord) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left whitespace-normal">
      <span className="break-words font-medium">
        {user.displayName || user.email}
      </span>{" "}
      {user.displayName && (
        <span className="break-all text-xs text-muted-foreground">
          {user.email}
        </span>
      )}
    </span>
  );
}

function ExistingTenantMemberFields() {
  const translate = useTranslate();
  return (
    <>
      <ReferenceInput
        source="existingUserId"
        reference="users"
        perPage={100}
        sort={{ field: "displayName", order: "ASC" }}
      >
        <AutocompleteInput
          optionText={tenantMemberLabel}
          inputText={tenantMemberLabel}
          popoverClassName="w-(--radix-popover-trigger-width)"
          label={translate("savia.tenants.fields.existingUser", {
            _: "Usuario existente",
          })}
          helperText={translate("savia.tenants.fields.existingUserHelper", {
            _: "El usuario dejará su organización actual: la transferencia no comparte la cuenta.",
          })}
          validate={required()}
        />
      </ReferenceInput>
      <SelectInput
        source="existingRole"
        label={translate("savia.tenants.fields.existingRole", {
          _: "Rol en el nuevo tenant",
        })}
        choices={[
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
            name: translate("savia.users.roles.viewer", {
              _: "Solo lectura",
            }),
          },
        ]}
        validate={required()}
      />
      <p className="text-sm text-muted-foreground md:col-span-2">
        {translate("savia.tenants.fields.existingUserWarning", {
          _: "No se puede transferir al último miembro activo de su organización ni a un administrador de plataforma.",
        })}
      </p>
    </>
  );
}

function TenantListActions() {
  const translate = useTranslate();
  const queryClient = useQueryClient();
  useRealtimeTopics({
    topics: ["tenants"],
    onConnected: (reason) => {
      if (reason === "subscription-change") return;
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
    },
    onEvent: (event) => {
      applyRealtimeListEvent(queryClient, "tenants", event);
    },
  });
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <CreateButton
        label={translate("savia.tenants.newTenant", { _: "Nuevo tenant" })}
      />
    </div>
  );
}

function tenantUsersPath(usersPath: string, tenantId: number) {
  const query = new URLSearchParams({
    filter: JSON.stringify({ tenantId }),
  });
  return `${usersPath}?${query}`;
}

function TenantList() {
  const translate = useTranslate();
  const createPath = useCreatePath();
  const usersPath = createPath({ resource: "users", type: "list" });

  return (
    <List
      title={translate("savia.tenants.title", { _: "Tenants" })}
      sort={{ field: "name", order: "ASC" }}
      actions={<TenantListActions />}
    >
      <DataTable<TenantRecord>
        rowClick={(_id, _resource, record) =>
          tenantUsersPath(usersPath, record.id)
        }
        bulkActionButtons={false}
      >
        <DataTable.Col
          source="name"
          label={translate("savia.tenants.table.tenant", { _: "Tenant" })}
        />
        <DataTable.Col
          source="idSlug"
          label={translate("savia.tenants.table.identifier", {
            _: "Identificador",
          })}
        />
        <DataTable.Col
          source="kind"
          label={translate("savia.tenants.table.type", { _: "Tipo" })}
          render={(record) => (
            <Badge
              variant={record.kind === "platform" ? "outline" : "secondary"}
            >
              {record.kind === "platform"
                ? translate("savia.tenants.table.internal", { _: "Interno" })
                : translate("savia.tenants.table.commercial", {
                    _: "Comercial",
                  })}
            </Badge>
          )}
        />
        <DataTable.Col
          source="isActive"
          label={translate("savia.tenants.table.status", { _: "Estado" })}
          render={(record) => (
            <Badge variant={record.isActive ? "default" : "secondary"}>
              {record.isActive
                ? translate("savia.tenants.table.active", { _: "Activo" })
                : translate("savia.tenants.table.inactive", {
                    _: "Inactivo",
                  })}
            </Badge>
          )}
        />
        <DataTable.Col
          label={translate("savia.tenants.table.actions", { _: "Acciones" })}
          render={(record) =>
            record.kind === "commercial" ? <EditButton iconOnly /> : null
          }
        />
      </DataTable>
    </List>
  );
}

function TenantCreate() {
  const translate = useTranslate();
  const [submissionError, setSubmissionError] =
    useState<TenantCreateSubmissionError>();
  return (
    <Create
      title={translate("savia.tenants.newTenant", { _: "Nuevo tenant" })}
      redirect="edit"
      mutationOptions={{
        onMutate: () => setSubmissionError(undefined),
        onError: (error) => {
          const code = tenantMutationErrorCode(error);
          setSubmissionError({
            message: tenantCreateErrorMessage(error, code),
            field:
              code === "TENANT_TEMPORARY_PASSWORD_INVALID"
                ? temporaryPasswordSource
                : undefined,
          });
        },
      }}
    >
      <SimpleForm
        className="max-w-2xl"
        noValidate
        defaultValues={{
          isActive: true,
          memberMode: "new",
          existingRole: "tenant_admin",
        }}
      >
        <TenantFields />
        <InitialTenantUserFields submissionError={submissionError} />
      </SimpleForm>
    </Create>
  );
}

function SavedTenantAccessUrl() {
  const record = useRecordContext<TenantRecord>();
  if (record?.kind !== "commercial") return null;
  return (
    <div className="md:col-span-2">
      <TenantAccessUrl
        key={`${record.id}:${record.idSlug}`}
        slug={record.idSlug}
      />
    </div>
  );
}

function TenantCapacityEditor() {
  const record = useRecordContext<TenantRecord>();
  return (
    <TenantUserCapacity
      tenantId={record ? Number(record.id) : null}
      platformCanEdit
    />
  );
}

function TenantOfficeSettings() {
  const record = useRecordContext<TenantRecord>();
  const services = useAppServices();
  if (!record || record.kind !== "commercial") return null;
  return (
    <div className="md:col-span-2">
      <OfficeSettingsPanel
        key={record.id}
        tenantId={Number(record.id)}
        services={services}
      />
    </div>
  );
}

function TenantPagesSearchEditor() {
  const record = useRecordContext<TenantRecord>();
  const { apiClient } = useAppServices();
  if (record?.kind !== "commercial" || !record.isActive || !apiClient?.get)
    return null;
  return (
    <TenantPagesSearchSettingsPanel
      key={record.id}
      services={{ apiClient }}
      tenantId={Number(record.id)}
    />
  );
}

function TenantAuthenticationLinks() {
  const record = useRecordContext<TenantRecord>();
  if (record?.kind !== "commercial" || !record.isActive) return null;
  return <TenantSignInLinks tenantId={Number(record.id)} />;
}

function TenantApiKeysEditor() {
  const record = useRecordContext<TenantRecord>();
  const { apiClient } = useAppServices();
  if (record?.kind !== "commercial" || !record.isActive || !apiClient?.get)
    return null;
  return (
    <div className="md:col-span-2">
      <TenantApiKeysPanel
        key={record.id}
        api={apiClient}
        tenantId={Number(record.id)}
      />
    </div>
  );
}

const tenantSettingsResetOptions = { keepDirtyValues: true };

function TenantSettingsToolbar() {
  const record = useRecordContext<TenantRecord>();
  const [name, isActive] = useWatch({ name: ["name", "isActive"] });
  const patch = tenantSettingsPatch({ name, isActive }, record);
  return (
    <FormToolbar>
      <div className="flex flex-row justify-end gap-2">
        <CancelButton />
        <SaveButton disabled={Object.keys(patch).length === 0} />
      </div>
    </FormToolbar>
  );
}

function TenantEditSections() {
  const record = useRecordContext<TenantRecord>();
  const { save } = useSaveContext();
  const { apiClient } = useAppServices();
  const t = useMessages(tenantSettingsMessages);
  const [tab, setTab] = useState("general");
  const [visited, setVisited] = useState(() => new Set(["general"]));
  const commercial = record?.kind === "commercial";
  const hasApi = Boolean(apiClient?.get);
  const hasKeys = commercial && record?.isActive && hasApi;
  const activeTab =
    (tab !== "general" && !commercial) ||
    (tab === "keys" && !hasKeys) ||
    (tab === "configuration" && !hasApi)
      ? "general"
      : tab;
  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        setTab(value);
        setVisited((current) => new Set([...current, value]));
      }}
      className="min-w-0 max-w-4xl gap-6"
    >
      <div className="min-w-0 overflow-x-auto border-b">
        <TabsList
          variant="line"
          aria-label={t("Tenant settings")}
          className="h-auto min-h-12 justify-start rounded-none px-0"
        >
          <TabsTrigger value="general" className="min-h-11 flex-none px-4">
            {t("General")}
          </TabsTrigger>
          {commercial ? (
            <TabsTrigger value="access" className="min-h-11 flex-none px-4">
              {t("Access")}
            </TabsTrigger>
          ) : null}
          {commercial && hasApi ? (
            <TabsTrigger
              value="configuration"
              className="min-h-11 flex-none px-4"
            >
              {t("Configuration")}
            </TabsTrigger>
          ) : null}
          {hasKeys ? (
            <TabsTrigger value="keys" className="min-h-11 flex-none px-4">
              {t("API keys")}
            </TabsTrigger>
          ) : null}
        </TabsList>
      </div>
      <TabsContent
        value="general"
        forceMount
        className="grid gap-8 data-[state=inactive]:hidden"
      >
        <SimpleForm
          className="max-w-2xl"
          resetOptions={tenantSettingsResetOptions}
          toolbar={<TenantSettingsToolbar />}
          onSubmit={async (values: Partial<TenantRecord>) => {
            const patch = tenantSettingsPatch(values, record);
            if (Object.keys(patch).length > 0) return save?.(patch);
          }}
        >
          <ResourceEditSync resource="tenants" />
          <TenantFields />
        </SimpleForm>
        <div className="max-w-2xl border-t pt-6">
          <TenantCapacityEditor />
        </div>
      </TabsContent>
      {commercial ? (
        <TabsContent
          value="access"
          forceMount
          className="grid gap-6 data-[state=inactive]:hidden"
        >
          <header className="grid gap-2">
            <h2 className="text-lg font-semibold">{t("Access")}</h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              {t("Manage access links and sign-in providers.")}
            </p>
          </header>
          <SavedTenantAccessUrl />
          <TenantAuthenticationLinks />
        </TabsContent>
      ) : null}
      {commercial && hasApi && visited.has("configuration") ? (
        <TabsContent
          value="configuration"
          forceMount
          className="grid gap-8 data-[state=inactive]:hidden"
        >
          <header className="grid gap-2">
            <h2 className="text-lg font-semibold">{t("Configuration")}</h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              {t("Configure the tools available to this tenant.")}
            </p>
          </header>
          <TenantOfficeSettings />
          <div className="border-t pt-6">
            <TenantPagesSearchEditor />
          </div>
        </TabsContent>
      ) : null}
      {hasKeys && visited.has("keys") ? (
        <TabsContent
          value="keys"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <TenantApiKeysEditor />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

type TenantEditSubmissionError = {
  tenantId: string;
  message: keyof typeof tenantSettingsMessages;
};

function TenantEditBody({
  submissionError,
}: {
  submissionError?: TenantEditSubmissionError;
}) {
  const record = useRecordContext<TenantRecord>();
  const t = useMessages(tenantSettingsMessages);
  const createPath = useCreatePath();
  if (record?.kind === "platform") {
    const usersPath = createPath({ resource: "users", type: "list" });
    return (
      <div className="grid max-w-2xl justify-items-start gap-4">
        <p className="text-sm text-muted-foreground">
          {t(
            "This is Savia’s internal workspace. Its general settings are read-only.",
          )}
        </p>
        <Button asChild variant="outline">
          <LinkBase to={tenantUsersPath(usersPath, record.id)}>
            {t("View users")}
          </LinkBase>
        </Button>
      </div>
    );
  }
  return (
    <>
      {submissionError?.tenantId === String(record?.id) && (
        <Alert variant="destructive" className="max-w-4xl">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{t(submissionError.message)}</AlertDescription>
        </Alert>
      )}
      <TenantEditSections key={`settings:${record?.id}`} />
      <TenantCascadeDelete key={`delete:${record?.id}`} />
    </>
  );
}

function TenantCascadeDelete() {
  const record = useRecordContext<TenantRecord>();
  const { isFetching } = useEditContext();
  const { permissions, isPending } = usePermissions<AuthPermissions>();
  const translate = useTranslate();
  const t = useMessages(tenantSettingsMessages);
  const redirect = useRedirect();
  const refresh = useRefresh();
  const [deleteTenant, { isPending: isDeleting }] = useDelete();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deletionError, setDeletionError] =
    useState<keyof typeof tenantSettingsMessages>();

  if (
    !record ||
    record.kind !== "commercial" ||
    isPending ||
    !permissions?.canManageIdentity
  ) {
    return null;
  }

  const canDelete = confirmation === record.name && !isDeleting && !isFetching;
  const close = () => {
    if (isDeleting) return;
    setIsOpen(false);
    setConfirmation("");
    setDeletionError(undefined);
  };
  const handleDelete = () => {
    if (!canDelete) return;
    setDeletionError(undefined);
    deleteTenant(
      "tenants",
      {
        id: record.id,
        previousData: record,
        meta: { cascade: true, confirmation },
      },
      {
        mutationMode: "pessimistic",
        onSuccess: () => {
          setIsOpen(false);
          redirect("list", "tenants");
        },
        onError: (error: unknown) => {
          const message = tenantCascadeDeleteErrorMessage(error);
          setDeletionError(message);
          const code = tenantMutationErrorCode(error);
          if (code === "TENANT_CONFIRMATION_REQUIRED") setConfirmation("");
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? error.status
              : undefined;
          if (
            code === "TENANT_CLEANUP_UNAVAILABLE" ||
            code === "TENANT_FILE_CLEANUP_UNAVAILABLE" ||
            code === "TENANT_AUTH_CLEANUP_UNAVAILABLE" ||
            code === "TENANT_CONFIRMATION_REQUIRED" ||
            message === tenantDeletionResultUnknown ||
            status === 409
          ) {
            refresh();
          }
        },
      },
    );
  };

  return (
    <section className="mt-8 max-w-2xl border-t pt-6">
      <h2 className="text-lg font-semibold text-destructive">
        {t("Delete tenant and all its data")}
      </h2>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        {t(
          "Permanently removes this commercial tenant and its associated data. This action cannot be undone.",
        )}
      </p>
      <Button
        type="button"
        variant="destructive"
        className="mt-4 min-h-11"
        onClick={() => setIsOpen(true)}
      >
        <Trash2 className="size-4" aria-hidden="true" />
        {t("Delete tenant and all its data")}
      </Button>
      <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Delete tenant and all its data")}</DialogTitle>
            <DialogDescription className="leading-relaxed break-words">
              {t(
                "Permanently removes this commercial tenant and its associated data. This action cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label
              htmlFor="tenant-delete-confirmation"
              className="min-w-0 break-words text-sm"
            >
              {t("Type %{name} to confirm", { name: record.name })}
            </label>
            <Input
              id="tenant-delete-confirmation"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={isDeleting || isFetching}
            />
          </div>
          {deletionError && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>{t(deletionError)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={isDeleting}
            >
              {translate("ra.action.cancel", { _: "Cancelar" })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={!canDelete}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {isDeleting ? t("Deleting…") : t("Delete permanently")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function tenantSettingsPatch(
  { name, isActive }: Partial<TenantRecord>,
  previous?: TenantRecord,
) {
  const trimmedName = name?.trim();
  return {
    ...(trimmedName !== undefined && trimmedName !== previous?.name?.trim()
      ? { name: trimmedName }
      : {}),
    ...(isActive !== undefined && isActive !== previous?.isActive
      ? { isActive }
      : {}),
  };
}

function TenantEditTitle() {
  const translate = useTranslate();
  const record = useRecordContext<TenantRecord>();
  return record?.kind === "platform"
    ? record.name
    : translate("savia.tenants.editTenant", { _: "Editar tenant" });
}

function TenantEdit() {
  const [submissionError, setSubmissionError] =
    useState<TenantEditSubmissionError>();
  return (
    <Edit
      title={<TenantEditTitle />}
      actions={false}
      mutationMode="pessimistic"
      mutationOptions={{
        onMutate: () => setSubmissionError(undefined),
        onError: (error, { id }) => {
          const status = error instanceof ApiClientError ? error.status : 0;
          setSubmissionError({
            tenantId: String(id),
            message:
              status >= 400 && status < 500 && status !== 408
                ? "Could not save the tenant. Review the information and try again."
                : "Savia could not confirm the save. Open the tenant in another tab to check the changes before retrying.",
          });
        },
      }}
    >
      <TenantEditBody submissionError={submissionError} />
    </Edit>
  );
}
export const tenants: ResourceProps = {
  name: "tenants",
  options: { label: "Tenants" },
  icon: Building2,
  recordRepresentation: "name",
  list: TenantList,
  create: TenantCreate,
  edit: TenantEdit,
};
