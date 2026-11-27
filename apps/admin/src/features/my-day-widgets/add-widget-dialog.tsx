import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Files,
  LoaderCircle,
  PlusCircle,
  TableProperties,
} from "lucide-react";
import type { ApiClient } from "@/api/api-client";
import { useSessionReadsPaused } from "@/auth/logout-progress";
import { useSessionGeneration } from "@/auth/session-scope";
import { ReadRefreshStatus } from "@/components/admin/read-refresh-status";
import { intlLocale, useAppLocale, useMessages } from "@/i18n/core";
import {
  createMyDayWidgetId,
  type MyDayWidget,
} from "@savia/studio-shared/my-day-widgets";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listWidgetTenants,
  normalizeCollections,
  normalizeSchema,
  type ObjectsResponse,
} from "./data";
import { availablePluginWidgets, listWidgetExtensions } from "./plugins";
import { autoDetectWidgetConfig } from "./summarize";
import { officeDocumentsWidgetMessages } from "./office-documents-widget-messages";
import { widgetMessages } from "./widget-messages";

const AUTO = "__auto";
type WidgetMessageKey = keyof typeof widgetMessages & string;

type Source = "collection" | "system";

type WorkspacePickerScope = { apiClient: ApiClient; sessionGeneration: number };
type CollectionPickerScope = WorkspacePickerScope & { apiBasePath: string };

function usePickerRead<Scope, Data>(
  scope: Scope | undefined,
  load: (scope: Scope, signal: AbortSignal) => Promise<Data>,
) {
  const [revision, setRevision] = useState(0);
  const [response, setResponse] = useState<
    { scope: Scope; revision: number } & (
      { status: "ready"; data: Data } | { status: "failed" }
    )
  >();
  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    const { signal } = controller;
    void load(scope, signal).then(
      (data) => {
        if (!signal.aborted)
          setResponse({ scope, revision, status: "ready", data });
      },
      () => {
        if (!signal.aborted) setResponse({ scope, revision, status: "failed" });
      },
    );
    return () => controller.abort();
  }, [scope, load, revision]);
  const current =
    response?.scope === scope && response?.revision === revision
      ? response
      : undefined;
  return {
    data: current?.status === "ready" ? current.data : undefined,
    failed: current?.status === "failed",
    loading: Boolean(scope) && !current,
    retry: () => setRevision((value) => value + 1),
  };
}

function readWorkspaces({ apiClient }: WorkspacePickerScope) {
  return listWidgetTenants(apiClient);
}

async function readObjects(
  { apiClient, apiBasePath }: CollectionPickerScope,
  signal: AbortSignal,
) {
  const response = await apiClient.get<ObjectsResponse>(
    `${apiBasePath}/api/objects`,
    { signal },
  );
  if (!Array.isArray(response?.data))
    throw new Error("Studio did not return a collection catalog.");
  return response;
}

function readExtensions(
  { apiClient, apiBasePath }: CollectionPickerScope,
  signal: AbortSignal,
) {
  return listWidgetExtensions(apiClient, apiBasePath, { signal });
}

export function AddWidgetDialog({
  open,
  onOpenChange,
  apiClient,
  onAdd,
  saving,
  existingKinds = [],
  mailAvailable = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiClient: ApiClient | undefined;
  onAdd: (widget: MyDayWidget) => Promise<boolean>;
  saving: boolean;
  existingKinds?: string[];
  mailAvailable?: boolean;
}) {
  const t = useMessages(widgetMessages);
  const officeT = useMessages(officeDocumentsWidgetMessages);
  const locale = useAppLocale();
  const uiLocale = intlLocale(locale);
  const extensionTitle = (title: { es: string; en?: string; pt?: string }) =>
    title[locale] ?? title.es;
  const sessionGeneration = useSessionGeneration();
  const readsPaused = useSessionReadsPaused();
  const [source, setSource] = useState<Source>("collection");
  const [workspaceSelection, setWorkspaceSelection] = useState<{
    scope: WorkspacePickerScope;
    path: string;
  }>();
  const [collectionSelection, setCollectionSelection] = useState<{
    scope: CollectionPickerScope;
    name: string;
  }>();
  const [preferredKind, setKind] = useState("summary");
  const [systemKind, setSystemKind] = useState<string>("agenda");
  const [statusField, setStatusField] = useState(AUTO);
  const [amountField, setAmountField] = useState(AUTO);
  const [limit, setLimit] = useState("5");
  const [feedback, setFeedback] = useState<WidgetMessageKey | null>(null);

  const hasMail = existingKinds.includes("mail");
  const hasAgenda = existingKinds.includes("agenda");
  const hasQuickTask = existingKinds.includes("quick_task");
  const hasOfficeDocuments = existingKinds.includes("office_documents");

  useEffect(() => {
    if (!open) return;
    setFeedback(null);
    setSource("collection");
    if (!hasAgenda) setSystemKind("agenda");
    else if (!hasQuickTask) setSystemKind("quick_task");
    else if (!hasOfficeDocuments) setSystemKind("office_documents");
  }, [open, hasAgenda, hasQuickTask, hasOfficeDocuments]);

  const workspaceScope = useMemo(
    () =>
      open && apiClient && !readsPaused && source === "collection"
        ? { apiClient, sessionGeneration }
        : undefined,
    [open, apiClient, readsPaused, sessionGeneration, source],
  );
  const workspaces = usePickerRead(workspaceScope, readWorkspaces);
  const tenants = workspaces.data ?? [];
  const chosenTenant =
    workspaceSelection?.scope === workspaceScope
      ? tenants.find((entry) => entry.apiBasePath === workspaceSelection?.path)
      : undefined;
  const tenantApiBasePath =
    (
      chosenTenant ??
      tenants.find((entry) => entry.kind === "platform") ??
      tenants[0]
    )?.apiBasePath ?? "";
  const collectionScope = useMemo(
    () =>
      workspaceScope && tenantApiBasePath
        ? { ...workspaceScope, apiBasePath: tenantApiBasePath }
        : undefined,
    [workspaceScope, tenantApiBasePath],
  );
  const objects = usePickerRead(collectionScope, readObjects);
  const plugins = usePickerRead(collectionScope, readExtensions);
  const collections = useMemo(
    () =>
      objects.data ? normalizeCollections(tenantApiBasePath, objects.data) : [],
    [objects.data, tenantApiBasePath],
  );
  const selected =
    collectionSelection?.scope === collectionScope
      ? collections.find((entry) => entry.name === collectionSelection?.name)
      : undefined;
  const collection = selected?.name ?? "";
  const schema = useMemo(
    () =>
      objects.data && collection
        ? normalizeSchema(tenantApiBasePath, objects.data, collection)
        : undefined,
    [objects.data, tenantApiBasePath, collection],
  );
  const detected = useMemo(
    () => (schema ? autoDetectWidgetConfig(schema) : {}),
    [schema],
  );
  const dropdownFields = useMemo(
    () => schema?.fields.filter((field) => field.type === "Dropdown") ?? [],
    [schema],
  );
  const numericFields = useMemo(
    () =>
      schema?.fields.filter(
        (field) => field.type === "Number" || field.type === "Currency",
      ) ?? [],
    [schema],
  );
  const pluginOptions = useMemo(
    () => availablePluginWidgets(collection, plugins.data),
    [collection, plugins.data],
  );
  const selectedPlugin = pluginOptions.find(
    (option) => `plugin:${option.extensionId}:${option.id}` === preferredKind,
  );
  const kind =
    preferredKind.startsWith("plugin:") && !selectedPlugin
      ? "summary"
      : preferredKind;
  const isPluginKind = kind.startsWith("plugin:");
  const needsGroup = kind === "chart";
  const needsDate = kind === "actions";
  let incompatibility: WidgetMessageKey | undefined;
  if (schema && needsGroup) {
    if (schema.summarySupported === false)
      incompatibility = "This source does not support charts by status.";
    else if (dropdownFields.length === 0)
      incompatibility =
        "This collection has no options to group by. Choose another type.";
  }
  if (schema && needsDate) {
    if (!detected.dateField)
      incompatibility =
        "This collection has no date fields. Choose another type.";
    else if (schema.sortSupported === false)
      incompatibility = "This source cannot sort records by due date.";
  }
  const canSaveCollection = Boolean(schema) && !incompatibility;

  function chooseCollection(name: string) {
    if (!collectionScope) return;
    setCollectionSelection({ scope: collectionScope, name });
    if (preferredKind.startsWith("plugin:")) setKind("summary");
    setStatusField(AUTO);
    setAmountField(AUTO);
  }

  async function save() {
    if (readsPaused || saving) return;
    if (source === "system") {
      if (
        (systemKind === "agenda" && hasAgenda) ||
        (systemKind === "quick_task" && hasQuickTask) ||
        (systemKind === "mail" && (hasMail || !mailAvailable)) ||
        (systemKind === "office_documents" && hasOfficeDocuments)
      ) {
        setFeedback("That widget is already on your dashboard.");
        return;
      }
      const widget = {
        id: systemKind,
        kind: systemKind,
      } as MyDayWidget;
      const ok = await onAdd(widget);
      if (ok) {
        onOpenChange(false);
        setCollectionSelection(undefined);
      }
      return;
    }
    if (!tenantApiBasePath || !collection) {
      setFeedback("Choose a tenant and a collection.");
      return;
    }
    if (!canSaveCollection) return;
    const parsedLimit = Number(limit);
    const groupValue =
      statusField !== AUTO ? statusField : detected.statusField;
    const amountValue =
      amountField !== AUTO ? amountField : detected.amountField;
    const widget: MyDayWidget = {
      id: createMyDayWidgetId(),
      apiBasePath: tenantApiBasePath as Extract<
        MyDayWidget,
        { apiBasePath: string }
      >["apiBasePath"],
      collection: collection as Extract<
        MyDayWidget,
        { collection: string }
      >["collection"],
      kind: kind as Extract<MyDayWidget, { apiBasePath: string }>["kind"],
      config: {
        ...(isPluginKind
          ? {}
          : {
              ...(kind === "chart"
                ? { ...(groupValue ? { groupField: groupValue } : {}) }
                : { ...(groupValue ? { statusField: groupValue } : {}) }),
              ...(amountValue ? { amountField: amountValue } : {}),
              ...(detected.dateField ? { dateField: detected.dateField } : {}),
            }),
        limit: Number.isInteger(parsedLimit) ? parsedLimit : 5,
        sort: "updated_at",
        order: "DESC",
      },
    };
    const ok = await onAdd(widget);
    if (ok) {
      onOpenChange(false);
      setCollectionSelection(undefined);
    }
  }

  const canSaveSystem =
    (systemKind === "agenda" && !hasAgenda) ||
    (systemKind === "quick_task" && !hasQuickTask) ||
    (systemKind === "mail" && !hasMail && mailAvailable) ||
    (systemKind === "office_documents" && !hasOfficeDocuments);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Add widget")}</DialogTitle>
          <DialogDescription>
            {t(
              "Combine your agenda with collection summaries in one dashboard. Everything is saved automatically, and you can reorder it by dragging.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {feedback ? (
            <p role="alert" className="text-sm text-destructive">
              {t(feedback)}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/60 p-1.5">
            <Button
              type="button"
              variant={source === "collection" ? "default" : "ghost"}
              size="sm"
              className="gap-1.5"
              onClick={() => setSource("collection")}
            >
              <TableProperties className="size-4" aria-hidden="true" />
              {t("Collection")}
            </Button>
            <Button
              type="button"
              variant={source === "system" ? "default" : "ghost"}
              size="sm"
              className="gap-1.5"
              onClick={() => setSource("system")}
            >
              <CalendarDays className="size-4" aria-hidden="true" />
              {t("Personal")}
            </Button>
          </div>

          {source === "system" ? (
            <div className="space-y-2">
              <Label htmlFor="widget-system">{t("System widget")}</Label>
              <Select value={systemKind} onValueChange={setSystemKind}>
                <SelectTrigger id="widget-system" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mailAvailable ? (
                    <SelectItem value="mail" disabled={hasMail}>
                      {t("Mail inbox")}
                      {hasMail ? ` (${t("Already added")})` : ""}
                    </SelectItem>
                  ) : null}
                  <SelectItem value="agenda" disabled={hasAgenda}>
                    <span className="flex items-center gap-2">
                      <CalendarDays className="size-4" aria-hidden="true" />
                      {t("Today's agenda")}
                      {hasAgenda ? ` (${t("Already added")})` : ""}
                    </span>
                  </SelectItem>
                  <SelectItem value="quick_task" disabled={hasQuickTask}>
                    <span className="flex items-center gap-2">
                      <PlusCircle className="size-4" aria-hidden="true" />
                      {t("Create a quick task")}
                      {hasQuickTask ? ` (${t("Already added")})` : ""}
                    </span>
                  </SelectItem>
                  <SelectItem
                    value="office_documents"
                    disabled={hasOfficeDocuments}
                  >
                    <span className="flex items-center gap-2">
                      <Files className="size-4" aria-hidden="true" />
                      {officeT("Office documents widget")}
                    </span>
                    {hasOfficeDocuments ? ` (${officeT("Already added")})` : ""}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm leading-6 text-muted-foreground">
                {systemKind === "office_documents"
                  ? officeT(
                      "Shows recent documents from Savia and connected drives.",
                    )
                  : systemKind === "mail"
                    ? t(
                        "Combines Gmail and Outlook messages and lets you compose with collection context.",
                      )
                    : systemKind === "agenda"
                      ? t(
                          "Shows your Google Calendar and Outlook events for today, with direct links.",
                        )
                      : t(
                          "A compact form for blocking time in your connected calendars.",
                        )}
              </p>
            </div>
          ) : (
            <>
              <ReadRefreshStatus
                refreshing={workspaces.loading}
                error={
                  workspaces.failed
                    ? t("Could not load the list of tenants.")
                    : undefined
                }
                onRetry={workspaces.retry}
              />
              {tenants.length !== 1 ? (
                <div className="space-y-2">
                  <Label htmlFor="widget-tenant">{t("Tenant")}</Label>
                  <Select
                    value={tenantApiBasePath}
                    onValueChange={(path) => {
                      if (workspaceScope)
                        setWorkspaceSelection({ scope: workspaceScope, path });
                    }}
                    disabled={tenants.length === 0}
                  >
                    <SelectTrigger id="widget-tenant" className="w-full">
                      <SelectValue placeholder={t("Choose a tenant")} />
                    </SelectTrigger>
                    <SelectContent>
                      {tenants.map((entry) => (
                        <SelectItem
                          key={entry.apiBasePath}
                          value={entry.apiBasePath}
                        >
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t(
                      "A tenant is the source data space. You will only see collections your user is allowed to access.",
                    )}
                  </p>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="widget-collection">{t("Collection")}</Label>
                <Select
                  value={collection}
                  onValueChange={chooseCollection}
                  disabled={collections.length === 0}
                >
                  <SelectTrigger id="widget-collection" className="w-full">
                    <SelectValue placeholder={t("Choose a collection")} />
                  </SelectTrigger>
                  <SelectContent>
                    {collections.map((entry) => (
                      <SelectItem key={entry.name} value={entry.name}>
                        {entry.label}
                        {typeof entry.count === "number"
                          ? ` (${new Intl.NumberFormat(uiLocale).format(entry.count)})`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ReadRefreshStatus
                  refreshing={objects.loading}
                  error={
                    objects.failed
                      ? t("Could not load this tenant's collections.")
                      : undefined
                  }
                  onRetry={objects.retry}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="widget-kind">{t("Widget type")}</Label>
                <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger id="widget-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="summary">
                      {t("Summary: total and count by status")}
                    </SelectItem>
                    <SelectItem value="items">
                      {t("Items: latest records")}
                    </SelectItem>
                    <SelectItem value="chart">
                      {t("Chart: bars by status")}
                    </SelectItem>
                    <SelectItem value="actions">
                      {t("Actions: overdue and upcoming")}
                    </SelectItem>
                    {pluginOptions.map((option) => (
                      <SelectItem
                        key={`${option.extensionId}:${option.id}`}
                        value={`plugin:${option.extensionId}:${option.id}`}
                      >
                        ✦ {extensionTitle(option.title)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ReadRefreshStatus
                  error={
                    plugins.failed
                      ? t("Could not load this tenant's plugin widgets.")
                      : undefined
                  }
                  onRetry={plugins.retry}
                />
              </div>
              {incompatibility ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(incompatibility)}
                </p>
              ) : null}
              {needsDate && schema && !incompatibility ? (
                <p className="text-sm text-muted-foreground">
                  {t("Date field detected: %{field}.", {
                    field: detected.dateField ?? t("Date field"),
                  })}
                </p>
              ) : null}
              {isPluginKind ? (
                <p className="text-sm text-muted-foreground">
                  {t(
                    "A view designed by the extension. It will use your permissions.",
                  )}
                </p>
              ) : null}
              {schema &&
              !needsDate &&
              !isPluginKind &&
              (kind === "items" || schema.summarySupported !== false) ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="widget-status">{t("Group by")}</Label>
                    <Select value={statusField} onValueChange={setStatusField}>
                      <SelectTrigger id="widget-status" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AUTO}>
                          {t("Automatic")}
                          {detected.statusField
                            ? ` (${detected.statusField})`
                            : ""}
                        </SelectItem>
                        {dropdownFields.map((field) => (
                          <SelectItem key={field.name} value={field.name}>
                            {field.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="widget-amount">{t("Sum field")}</Label>
                    <Select value={amountField} onValueChange={setAmountField}>
                      <SelectTrigger id="widget-amount" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AUTO}>
                          {t("Automatic")}
                          {detected.amountField
                            ? ` (${detected.amountField})`
                            : ""}
                        </SelectItem>
                        {numericFields.map((field) => (
                          <SelectItem key={field.name} value={field.name}>
                            {field.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="widget-limit">{t("Visible items")}</Label>
                <Select value={limit} onValueChange={setLimit}>
                  <SelectTrigger id="widget-limit" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">3</SelectItem>
                    <SelectItem value="5">5</SelectItem>
                    <SelectItem value="8">8</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {selected ? (
                <p className="text-sm text-muted-foreground">
                  {t("Preview: %{kind} for %{collection}", {
                    kind:
                      kind === "summary"
                        ? t("summary")
                        : kind === "items"
                          ? t("items")
                          : kind === "chart"
                            ? t("chart")
                            : kind === "actions"
                              ? t("actions")
                              : extensionTitle(
                                  selectedPlugin?.title ?? {
                                    es: t("extension"),
                                  },
                                ),
                    collection: selected.label,
                  })}
                </p>
              ) : null}
            </>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={
              readsPaused ||
              saving ||
              (source === "system" ? !canSaveSystem : !canSaveCollection)
            }
          >
            {saving ? <LoaderCircle className="animate-spin" /> : null}
            {t("Add widget")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
