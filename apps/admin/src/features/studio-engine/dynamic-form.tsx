import { configureFormEngineLocale } from "@/i18n/form-engine-locale";
import { useAppLocale } from "@/i18n/core";
import { useMessages } from "@/i18n/core";
import { recordsMessages } from "@/i18n/locales/records";
import { RelatedRecordEditor } from "./related-record-editor";
import type { RelatedRecordChanges } from "@savia/studio-shared/related-records";
import { canonicalJson } from "@savia/studio-shared/solution-package";
import { DateTimeField } from "./date-time-field";
import { CollectionOptionField } from "./collection-option-field";
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useWatch } from "react-hook-form";
import {
  FormEngine,
  InjectedFieldProvider,
  RulesEngineProvider,
  type IEntityData,
  type IFieldProps,
} from "@form-eng/core";
import ConversationWizard from "./conversation-wizard";
import {
  AttachmentQueueProvider,
  releaseUnavailableAttachmentUploads,
  updateUploadingFiles,
  type AttachmentUploadFailure,
} from "./attachment-queue";
import { registry } from "./fields";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ArrowLeft, ArrowRight, Check, LoaderCircle, Save } from "lucide-react";
import {
  fieldEntries,
  FORM_HTML_TYPE,
  DISPLAY_TEXT_TYPE,
  R2_ATTACHMENT_TYPE,
  resolveFieldLabel,
  validateRecord,
  type StudioRecord,
  type StudioObject,
} from "@savia/studio-shared/metadata";
import { useFieldLabelLocale } from "./localized-field-label-editor";
import {
  evaluateCondition,
  isSectionVisible,
  prepareRecord,
} from "@savia/studio-shared/rules";
import {
  discardTemporaryAttachmentsInBackground,
  expiredAttachmentIds,
  TemporaryAttachmentUnavailableError,
  type TemporaryR2Attachment,
} from "./r2-attachment-upload";
import "./designer-enhancements.css";
import "./wizard.css";
const EMPTY_VALUES: Record<string, unknown> = {};

const WizardContext = createContext<{
  active: string;
  first: string;
  activeTitle?: string;
} | null>(null);
function WizardField({
  element,
  object,
  ...props
}: IFieldProps & { element: ReactElement<IFieldProps>; object: StudioObject }) {
  const wizard = useContext(WizardContext);
  const values = useWatch();
  const section = props.config?.section
    ? object.config.studio?.sections?.find(
        (s) => s.id === props.config?.section,
      )
    : undefined;
  const hidden =
    (!!wizard && (props.config?.step ?? wizard.first) !== wizard.active) ||
    (!!props.config?.section && !isSectionVisible(section, values)) ||
    Boolean(
      props.config?.visibleWhen &&
      !evaluateCondition(props.config.visibleWhen as any, values),
    );
  return (
    <div
      hidden={hidden}
      {...(hidden ? { inert: true, "aria-hidden": true } : {})}
    >
      {props.config?.collectionRelationTarget &&
      ["subform", "table"].includes(
        String(props.config?.relationPresentation),
      ) ? (
        <RelatedRecordEditor {...props} />
      ) : props.config?.dateTime === true ? (
        <DateTimeField {...props} />
      ) : props.config?.collectionOptions ? (
        <CollectionOptionField
          {...props}
          objectName={object.name}
          numeric={
            object.config.fields[props.fieldName!]?.type === "Number" ||
            object.config.fields[props.fieldName!]?.type === "Currency"
          }
        />
      ) : (
        cloneElement(element, props)
      )}
    </div>
  );
}
const wizardRegistry = (object: StudioObject) =>
  Object.fromEntries(
    Object.entries(registry).map(([name, element]) => [
      name,
      <WizardField
        object={object}
        element={element as ReactElement<IFieldProps>}
      />,
    ]),
  );

function FormValuesObserver({
  onChange,
}: {
  onChange?: (values: Record<string, unknown>) => void;
}) {
  const values = useWatch();
  const callback = useRef(onChange);
  callback.current = onChange;
  const serialized = JSON.stringify(values);
  useEffect(() => {
    callback.current?.(JSON.parse(serialized));
  }, [serialized]);
  return null;
}

function FieldLabel({ object, name }: { object: StudioObject; name: string }) {
  const t = useMessages(recordsMessages);
  const validationLocale = useAppLocale();

  const values = useWatch();
  const wizard = useContext(WizardContext);
  const locale = useFieldLabelLocale();
  const field = object.config.fields[name];
  if (!field) return null;
  if (field.type === FORM_HTML_TYPE || field.type === DISPLAY_TEXT_TYPE) {
    if (!field.description) return null;
    return (
      <p className="studio-field-help form-html-field-description">
        {field.description}
      </p>
    );
  }
  const cfg = field.config ?? {};
  const studio = (object.config as any).studio;
  const sectionDef = cfg.section
    ? studio?.sections?.find((s: { id: string }) => s.id === cfg.section)
    : undefined;
  const sectionVisible = !cfg.section || isSectionVisible(sectionDef, values);
  const visible =
    sectionVisible &&
    !field.hidden &&
    (!wizard || (cfg.step ?? wizard.first) === wizard.active) &&
    (!cfg.visibleWhen || evaluateCondition(cfg.visibleWhen as any, values));
  const required =
    visible &&
    (field.required ||
      (cfg.requiredWhen && evaluateCondition(cfg.requiredWhen as any, values)));
  const entries = fieldEntries(object);
  const firstInSection =
    cfg.section &&
    sectionVisible &&
    entries.find(([, f]) => {
      const fCfg = f.config ?? {};
      const fSection = fCfg.section
        ? studio?.sections?.find((s: { id: string }) => s.id === fCfg.section)
        : undefined;
      return (
        fCfg.section === cfg.section &&
        (!fCfg.section || isSectionVisible(fSection, values)) &&
        !f.hidden &&
        (!wizard || (fCfg.step ?? wizard.first) === wizard.active) &&
        (!fCfg.visibleWhen ||
          evaluateCondition(fCfg.visibleWhen as any, values))
      );
    })?.[0] === name;
  const section = sectionDef;
  const resolvedLabel = resolveFieldLabel(field, locale);
  const label =
    field.type === R2_ATTACHMENT_TYPE && resolvedLabel === "Archivo R2"
      ? t("Archivo adjunto")
      : resolvedLabel;
  return (
    <div
      hidden={!visible}
      {...(!visible ? { inert: true, "aria-hidden": true } : {})}
      className="studio-field-heading"
      data-hidden={!visible || undefined}
      data-wide={cfg.width === 2 || undefined}
      data-section-start={!!firstInSection || undefined}
    >
      {firstInSection &&
        section &&
        !(wizard?.activeTitle && section.label === wizard.activeTitle) && (
          <h3 className="studio-section-title">{section.label}</h3>
        )}
      <Label
        htmlFor={String(cfg.inputId ?? name)}
        id={`${cfg.inputId ?? name}_label`}
      >
        {label}
        {required ? (
          <span className="required" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </Label>
      {field.description && (
        <p className="studio-field-help">{field.description}</p>
      )}
    </div>
  );
}

export type DynamicFormProps = {
  /** Keep a transient copy separate from the ordinary persisted create draft. */
  ephemeralDraft?: boolean;
  object: StudioObject;
  values?: Record<string, unknown>;
  onSave: (
    data: Record<string, unknown>,
    previous?: StudioRecord,
    relations?: RelatedRecordChanges[],
    options?: { idempotencyKey?: string; hasTemporaryAttachments?: boolean },
  ) => Promise<StudioRecord | void>;
  onPersistAttachments?: (
    record: StudioRecord,
    attachments: PendingAttachment[],
    onStatus: (status: AttachmentUploadStatus) => void,
  ) => Promise<void>;
  onUploadTemporaryAttachment?: (
    field: string,
    file: File,
    recordId?: string,
    createRequestKey?: string,
  ) => Promise<TemporaryR2Attachment>;
  onPersistTemporaryAttachments?: (
    record: StudioRecord,
    attachments: TemporaryR2Attachment[],
  ) => Promise<void>;
  onDiscardTemporaryAttachments?: (
    attachments: TemporaryR2Attachment[],
  ) => Promise<void>;
  onCancel?: () => void;
  onSaved?: (record: StudioRecord | void) => void;
  submitLabel?: string;
  formActions?: React.ReactNode;
  renderFieldActions?: (field: string) => React.ReactNode;
  onValuesChange?: (values: Record<string, unknown>) => void;
};
export type PendingAttachment = { field: string; files: File[] };
export type AttachmentUploadStatus = {
  field: string;
  file: File;
  status: "uploaded" | "uploading";
};
export default function DynamicForm(props: DynamicFormProps) {
  if (
    !Object.values(props.object.config.fields).some(
      (field) =>
        field.config?.collectionRelationTarget &&
        ["subform", "table"].includes(
          String(field.config?.relationPresentation),
        ),
    ) &&
    props.object.config.studio?.wizard?.enabled &&
    props.object.config.studio.wizard.presentation !== "steps"
  )
    return <ConversationWizard {...props} />;
  return <StepForm {...props} />;
}
function StepForm({
  object,
  values = EMPTY_VALUES,
  onSave,
  onPersistAttachments,
  onUploadTemporaryAttachment,
  onPersistTemporaryAttachments,
  onDiscardTemporaryAttachments,
  onCancel,
  onSaved,
  submitLabel: suppliedSubmitLabel,
  formActions,
  renderFieldActions,
  onValuesChange,
}: {
  object: StudioObject;
  values?: Record<string, unknown>;
  onSave: DynamicFormProps["onSave"];
  onPersistAttachments?: (
    record: StudioRecord,
    attachments: PendingAttachment[],
    onStatus: (status: AttachmentUploadStatus) => void,
  ) => Promise<void>;
  onUploadTemporaryAttachment?: DynamicFormProps["onUploadTemporaryAttachment"];
  onPersistTemporaryAttachments?: (
    record: StudioRecord,
    attachments: TemporaryR2Attachment[],
  ) => Promise<void>;
  onDiscardTemporaryAttachments?: (
    attachments: TemporaryR2Attachment[],
  ) => Promise<void>;
  onCancel?: () => void;
  onSaved?: (record: StudioRecord | void) => void;
  submitLabel?: string;
  formActions?: React.ReactNode;
  renderFieldActions?: (field: string) => React.ReactNode;
  onValuesChange?: (values: Record<string, unknown>) => void;
}) {
  const t = useMessages(recordsMessages);
  const validationLocale = useAppLocale();
  const submitLabel = suppliedSubmitLabel ?? t("Guardar registro");
  useMemo(
    () => configureFormEngineLocale(validationLocale),
    [validationLocale],
  );

  const managedObject = ["managed-customer", "managed-agency"].includes(
    object.config.studio?.business ?? "",
  );
  const managedEdit =
    (managedObject || Boolean(object.config.studio?.collection)) &&
    Boolean(values.id);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [queuedAttachments, setQueuedAttachments] = useState<
    Record<string, File[]>
  >({});
  const [uploadingAttachments, setUploadingAttachments] = useState<
    Record<string, File[]>
  >({});
  const [failedAttachments, setFailedAttachments] = useState<
    AttachmentUploadFailure[]
  >([]);
  const [temporaryAttachments, setTemporaryAttachments] = useState<
    { field: string; file: File; attachment: TemporaryR2Attachment }[]
  >([]);
  const [attachmentVersion, setAttachmentVersion] = useState(0);
  const [savedRecordId, setSavedRecordId] = useState(() =>
    String(values.id ?? ""),
  );
  const confirmedWrite = useRef<
    | {
        record: StudioRecord;
        payload: string;
        fields?: Record<string, string | undefined>;
        pendingAttachments: boolean;
      }
    | undefined
  >(undefined);
  const steps = object.config.studio?.wizard?.enabled
    ? object.config.studio.wizard.steps
    : [];
  const [stepIndex, setStepIndex] = useState(0);
  const activeIndex = Math.min(stepIndex, Math.max(0, steps.length - 1));
  const activeStep = steps[activeIndex];
  const lastStep = !activeStep || activeIndex === steps.length - 1;
  const root = useRef<HTMLDivElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const queuedAttachmentsRef = useRef<Record<string, File[]>>({});
  const temporaryAttachmentsRef = useRef<
    { field: string; file: File; attachment: TemporaryR2Attachment }[]
  >([]);
  const submittedAttachments = useRef<TemporaryR2Attachment[] | undefined>(
    undefined,
  );
  const handledAttachmentsRef = useRef(new Set<File>());
  const cancelledRef = useRef(false);
  const discardTemporaryAttachmentsRef = useRef(onDiscardTemporaryAttachments);
  useEffect(() => {
    discardTemporaryAttachmentsRef.current = onDiscardTemporaryAttachments;
  }, [onDiscardTemporaryAttachments]);
  useEffect(
    () => () => {
      cancelledRef.current = true;
      const attachments = temporaryAttachmentsRef.current
        .map(({ attachment }) => attachment)
        .filter(
          (attachment) => !submittedAttachments.current?.includes(attachment),
        );
      discardTemporaryAttachmentsInBackground(
        discardTemporaryAttachmentsRef.current,
        attachments,
      );
    },
    [],
  );
  const [focusField, setFocusField] = useState("");
  const editorKey = `${object.name}:${String(values.id ?? "new")}`;
  useEffect(() => {
    queuedAttachmentsRef.current = {};
    temporaryAttachmentsRef.current = [];
    handledAttachmentsRef.current.clear();
    cancelledRef.current = false;
    setQueuedAttachments({});
    setUploadingAttachments({});
    setFailedAttachments([]);
    setTemporaryAttachments([]);
    setAttachmentVersion(0);
    setSavedRecordId(String(values.id ?? ""));
    confirmedWrite.current = undefined;
  }, [editorKey, values.id]);
  const replaceTemporaryAttachments = (
    next: { field: string; file: File; attachment: TemporaryR2Attachment }[],
  ) => {
    temporaryAttachmentsRef.current = next;
    setTemporaryAttachments(next);
  };
  const restartTemporaryUploads = (ids: string[]) => {
    const previous = temporaryAttachmentsRef.current;
    const retained = releaseUnavailableAttachmentUploads(
      previous,
      ids,
      handledAttachmentsRef.current,
    );
    if (retained === previous) return false;
    replaceTemporaryAttachments(retained);
    setQueuedAttachments({ ...queuedAttachmentsRef.current });
    setError(
      t("Estamos volviendo a cargar un adjunto. Guarda cuando termine."),
    );
    return true;
  };
  const setAttachmentFiles = (field: string, files: File[]) => {
    if (submittedAttachments.current) return;
    for (const previous of queuedAttachmentsRef.current[field] ?? [])
      if (!files.includes(previous))
        handledAttachmentsRef.current.delete(previous);
    setFailedAttachments((previous) =>
      previous.filter(
        (failure) => failure.field !== field || files.includes(failure.file),
      ),
    );
    const next = { ...queuedAttachmentsRef.current, [field]: files };
    queuedAttachmentsRef.current = next;
    setQueuedAttachments(next);
  };
  const retryAttachment = (field: string, file: File) => {
    if (
      submittedAttachments.current ||
      !failedAttachments.some(
        (failure) => failure.field === field && failure.file === file,
      )
    )
      return;
    handledAttachmentsRef.current.delete(file);
    setFailedAttachments((previous) =>
      previous.filter(
        (failure) => failure.field !== field || failure.file !== file,
      ),
    );
    setQueuedAttachments({ ...queuedAttachmentsRef.current });
  };
  useEffect(() => {
    if (!onUploadTemporaryAttachment) return;
    const removed = temporaryAttachmentsRef.current.filter(
      ({ field, file }) => !queuedAttachmentsRef.current[field]?.includes(file),
    );
    if (removed.length) {
      replaceTemporaryAttachments(
        temporaryAttachmentsRef.current.filter(
          (entry) => !removed.includes(entry),
        ),
      );
      if (onDiscardTemporaryAttachments)
        void onDiscardTemporaryAttachments(
          removed.map(({ attachment }) => attachment),
        ).catch((cause: Error) => setError(cause.message));
    }
    for (const [field, files] of Object.entries(queuedAttachments))
      for (const file of files) {
        if (handledAttachmentsRef.current.has(file)) continue;
        handledAttachmentsRef.current.add(file);
        setUploadingAttachments((previous) =>
          updateUploadingFiles(previous, field, file, true),
        );
        void onUploadTemporaryAttachment(
          field,
          file,
          savedRecordId || undefined,
        )
          .then((attachment) => {
            if (
              cancelledRef.current ||
              !queuedAttachmentsRef.current[field]?.includes(file)
            ) {
              discardTemporaryAttachmentsInBackground(
                onDiscardTemporaryAttachments,
                [attachment],
              );
              return;
            }
            replaceTemporaryAttachments([
              ...temporaryAttachmentsRef.current,
              { field, file, attachment },
            ]);
            setAttachmentVersion((version) => version + 1);
          })
          .catch((cause: unknown) => {
            if (
              cancelledRef.current ||
              !queuedAttachmentsRef.current[field]?.includes(file)
            )
              return;
            setFailedAttachments((previous) => [
              ...previous,
              {
                field,
                file,
                message: cause instanceof Error ? cause.message : "",
              },
            ]);
          })
          .finally(() =>
            setUploadingAttachments((previous) =>
              updateUploadingFiles(previous, field, file, false),
            ),
          );
      }
  }, [
    onDiscardTemporaryAttachments,
    onUploadTemporaryAttachment,
    queuedAttachments,
    savedRecordId,
  ]);
  const uploadedAttachmentFiles = useMemo(
    () =>
      temporaryAttachments.reduce<Record<string, File[]>>((files, entry) => {
        files[entry.field] = [...(files[entry.field] ?? []), entry.file];
        return files;
      }, {}),
    [temporaryAttachments],
  );
  const hasPendingAttachmentUpload = Object.values(uploadingAttachments).some(
    (files) => files.length > 0,
  );
  const markAttachmentUploaded = (field: string, file: File) =>
    setQueuedAttachments((previous) => ({
      ...previous,
      [field]: (previous[field] ?? []).filter((queued) => queued !== file),
    }));
  const refreshAttachments = (field: string, file: File) => {
    markAttachmentUploaded(field, file);
    setAttachmentVersion((version) => version + 1);
  };
  const updateAttachmentStatus = ({
    field,
    file,
    status,
  }: AttachmentUploadStatus) => {
    setUploadingAttachments((previous) =>
      updateUploadingFiles(previous, field, file, status === "uploading"),
    );
    if (status === "uploaded") refreshAttachments(field, file);
  };
  useEffect(() => {
    if (activeStep) {
      if (focusField)
        root.current
          ?.querySelector<HTMLElement>(`[id="${focusField}"]`)
          ?.focus();
      else heading.current?.focus();
    }
  }, [activeIndex, focusField]);
  const goBack = (index: number) => {
    setStepIndex(index);
    setError("");
    setFieldErrors({});
    setFocusField("");
  };
  const cancel = () => {
    if (submittedAttachments.current) return;
    cancelledRef.current = true;
    queuedAttachmentsRef.current = {};
    setQueuedAttachments({});
    setFailedAttachments([]);
    const attachments = temporaryAttachmentsRef.current.map(
      ({ attachment }) => attachment,
    );
    replaceTemporaryAttachments([]);
    discardTemporaryAttachmentsInBackground(
      onDiscardTemporaryAttachments,
      attachments,
    );
    onCancel?.();
  };
  // Shared validation owns required/conditional checks; form-engine remains the live form runtime.
  // Remote relations use their own runtime type: Dropdown clears IDs absent from its
  // local options catalog, which is incomplete by definition for paginated relations.
  const orderedFields = useMemo(
    () =>
      [...fieldEntries(object)].sort((a, b) => {
        const sections = object.config.studio?.sections ?? [];
        const rank = (section: unknown) =>
          section ? sections.findIndex((s) => s.id === section) + 1 : 0;
        return rank(a[1].config?.section) - rank(b[1].config?.section);
      }),
    [object],
  );
  const config = useMemo(
    () => ({
      ...object.config,
      settings: {
        ...object.config.settings,
        manualSave: true,
        ...(managedObject ||
        object.config.studio?.collection ||
        object.config.studio?.requestPage
          ? { expandCutoffCount: Object.keys(object.config.fields).length + 1 }
          : {}),
      },
      fieldOrder: orderedFields.map(([name]) => name),
      fields: Object.fromEntries(
        orderedFields.map(([name, field]) => [
          name,
          {
            ...field,
            type: field.config?.collectionRelationTarget
              ? "StudioCollectionRelation"
              : field.config?.relation
                ? "StudioRelation"
                : field.type,
            required: false,
            readOnly:
              field.readOnly ||
              !!field.config?.formula ||
              (managedEdit &&
                object.config.studio?.business === "managed-customer" &&
                name === "person_type"),
            config: {
              ...field.config,
              recordId: values.id ?? savedRecordId,
              studioObject: object,
            },
          },
        ]),
      ),
    }),
    [
      object,
      managedEdit,
      managedObject,
      savedRecordId,
      values.id,
      orderedFields,
    ],
  );
  const defaults = useMemo(() => {
    const initial = Object.fromEntries(
      fieldEntries(object).map(([name, field]) => [
        name,
        values[name] ??
          field.defaultValue ??
          (field.config?.multiple ||
          field.type === "MultiSelect" ||
          field.type === R2_ATTACHMENT_TYPE
            ? []
            : field.type === "Toggle"
              ? false
              : ""),
      ]),
    );
    try {
      return prepareRecord(object, initial);
    } catch {
      return initial;
    }
  }, [object, values]);
  return (
    <div
      ref={root}
      className="dynamic-form studio-form"
      data-columns={(object.config as any).studio?.columns ?? 1}
    >
      {activeStep && (
        <div className="wizard-header">
          <nav aria-label={t("Pasos del formulario")}>
            <ol className="wizard-steps">
              {steps.map((step, index) => {
                const label = (
                  <>
                    <span className="wizard-step-number" aria-hidden="true">
                      {index < activeIndex ? <Check size={14} /> : index + 1}
                    </span>
                    <span>{step.title}</span>
                  </>
                );
                return (
                  <li key={step.id}>
                    {index < activeIndex ? (
                      <button
                        type="button"
                        className="wizard-step wizard-step-complete"
                        disabled={busy}
                        onClick={() => goBack(index)}
                      >
                        {label}
                      </button>
                    ) : index === activeIndex ? (
                      <span
                        className="wizard-step wizard-step-current"
                        aria-current="step"
                      >
                        {label}
                      </span>
                    ) : (
                      <span
                        className="wizard-step wizard-step-upcoming"
                        aria-disabled="true"
                      >
                        {label}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <h3 ref={heading} tabIndex={-1} className="sr-only">
            {t("Paso")} {activeIndex + 1} {t("de")} {steps.length}:{" "}
            {activeStep.title}
          </h3>
          {activeStep.description && (
            <p className="studio-field-help wizard-step-description">
              {activeStep.description}
            </p>
          )}
        </div>
      )}
      <WizardContext.Provider
        value={
          activeStep
            ? {
                active: activeStep.id,
                first: steps[0].id,
                activeTitle: activeStep.title,
              }
            : null
        }
      >
        <AttachmentQueueProvider
          value={{
            files: queuedAttachments,
            setFiles: setAttachmentFiles,
            uploading: uploadingAttachments,
            uploaded: uploadedAttachmentFiles,
            failures: failedAttachments,
            retry: retryAttachment,
            version: attachmentVersion,
            saving: busy,
          }}
        >
          <RulesEngineProvider>
            <InjectedFieldProvider injectedFields={wizardRegistry(object)}>
              <FormEngine
                configName={`${object.name}-${values.id ?? "new"}`}
                programName="savia-crm"
                formConfig={config}
                defaultValues={defaults as IEntityData}
                entityType={object.name}
                entityId={String(values.id ?? "new")}
                isCreate={!values.id}
                isManualSave
                renderSaveButton={() => null}
                renderLabel={({ id }) => (
                  <>
                    <FieldLabel object={object} name={id} />
                    {renderFieldActions?.(id)}
                  </>
                )}
                renderStatus={() => (
                  <FormValuesObserver onChange={onValuesChange} />
                )}
                renderError={({ id, error: runtimeError }) =>
                  fieldErrors[id] || runtimeError ? (
                    <p
                      hidden={
                        !!activeStep &&
                        (object.config.fields[id]?.config?.step ??
                          steps[0].id) !== activeStep.id
                      }
                      id={`${id}_error`}
                      role="alert"
                    >
                      {fieldErrors[id] ??
                        runtimeError?.message ??
                        t("Revisa este campo")}
                    </p>
                  ) : null
                }
                onSubmit={async (data) => {
                  if (submittedAttachments.current) return;
                  setError("");
                  setFieldErrors({});
                  try {
                    const related = Object.entries(object.config.fields).filter(
                      ([, field]) =>
                        field.config?.collectionRelationTarget &&
                        ["subform", "table"].includes(
                          String(field.config?.relationPresentation),
                        ),
                    );
                    // Validate required relation selections as IDs, then preserve staged rows.
                    const validationData = { ...data };
                    for (const [name, field] of related) {
                      const rows = Array.isArray(data[name])
                        ? (data[name] as unknown[])
                        : [];
                      validationData[name] = field.config?.multiple
                        ? rows.map((_, index) => String(index))
                        : rows.length
                          ? "selected"
                          : "";
                    }
                    const result = validateRecord(
                      object,
                      validationData,
                      validationLocale,
                    );
                    for (const [name] of related)
                      result.data[name] = data[name];
                    for (const [name] of related) {
                      const invalid =
                        Array.isArray(data[name]) &&
                        (data[name] as Array<{ __errors?: string[] }>).some(
                          (row) => row.__errors?.length,
                        );
                      if (invalid)
                        result.errors[name] = t(
                          "Revisa los campos del registro relacionado antes de guardar.",
                        );
                    }
                    const previousWrite = confirmedWrite.current;
                    const fieldValues = managedEdit
                      ? Object.fromEntries(
                          Object.keys(object.config.fields).map((name) => [
                            name,
                            JSON.stringify(data[name]),
                          ]),
                        )
                      : undefined;
                    const changedFields =
                      fieldValues &&
                      new Set(
                        Object.keys(fieldValues).filter((name) => {
                          const previousFields = previousWrite?.fields;
                          const previousValue = previousFields
                            ? previousFields[name]
                            : JSON.stringify(defaults[name]);
                          return fieldValues[name] !== previousValue;
                        }),
                      );
                    const relevantErrors = Object.fromEntries(
                      Object.entries(result.errors).filter(
                        ([name]) =>
                          (!changedFields ||
                            name === "_form" ||
                            changedFields.has(name)) &&
                          (lastStep ||
                            name === "_form" ||
                            (object.config.fields[name]?.config?.step ??
                              steps[0]?.id) === activeStep?.id),
                      ),
                    );
                    if (Object.keys(relevantErrors).length) {
                      setFieldErrors(relevantErrors);
                      setError(
                        activeStep
                          ? t("Revisa los campos señalados antes de continuar.")
                          : t("Revisa los campos señalados antes de guardar."),
                      );
                      const firstError = fieldEntries(object).find(
                        ([name]) => relevantErrors[name],
                      )?.[0];
                      if (firstError) {
                        if (activeStep && lastStep) {
                          const destination = steps.findIndex(
                            (step) =>
                              step.id ===
                              object.config.fields[firstError]?.config?.step,
                          );
                          if (destination >= 0) setStepIndex(destination);
                        }
                        setFocusField(firstError);
                      }
                      return;
                    }
                    const failed = failedAttachments.find(
                      ({ field }) =>
                        lastStep ||
                        (object.config.fields[field]?.config?.step ??
                          steps[0]?.id) === activeStep?.id,
                    );
                    if (failed) {
                      if (activeStep && lastStep) {
                        const step =
                          object.config.fields[failed.field]?.config?.step ??
                          steps[0]?.id;
                        const destination = steps.findIndex(
                          ({ id }) => id === step,
                        );
                        if (destination >= 0) setStepIndex(destination);
                      }
                      setFocusField(failed.field);
                      return;
                    }
                    if (activeStep && !lastStep) {
                      setStepIndex(activeIndex + 1);
                      setFocusField("");
                      return;
                    }
                    if (hasPendingAttachmentUpload) {
                      setError(
                        t("Espera a que termine la carga de los archivos."),
                      );
                      return;
                    }
                    const temporary = temporaryAttachmentsRef.current.map(
                      ({ attachment }) => attachment,
                    );
                    const queuedCount = Object.values(queuedAttachments).reduce(
                      (total, files) => total + files.length,
                      0,
                    );
                    if (
                      onUploadTemporaryAttachment &&
                      queuedCount !== temporary.length
                    ) {
                      setError(
                        t(
                          "Revisa los archivos antes de guardar. Uno o más no se pudieron cargar.",
                        ),
                      );
                      return;
                    }
                    if (
                      !confirmedWrite.current &&
                      restartTemporaryUploads(expiredAttachmentIds(temporary))
                    )
                      return;
                    submittedAttachments.current = temporary;
                    setBusy(true);
                    const attachments = fieldEntries(object).flatMap(
                      ([field, definition]) =>
                        definition.type === R2_ATTACHMENT_TYPE &&
                        queuedAttachments[field]?.length
                          ? [{ field, files: queuedAttachments[field] }]
                          : [],
                    );
                    const recordData = changedFields
                      ? Object.fromEntries(
                          Object.entries(result.data).filter(([name]) =>
                            changedFields.has(name),
                          ),
                        )
                      : result.data;
                    const payload = canonicalJson(recordData);
                    const recordChanged = changedFields
                      ? changedFields.size > 0
                      : payload !== previousWrite?.payload;
                    let saved: StudioRecord | void = previousWrite?.record;
                    if (!previousWrite?.pendingAttachments || recordChanged) {
                      saved = temporary.length
                        ? await onSave(
                            recordData,
                            previousWrite?.record,
                            undefined,
                            {
                              hasTemporaryAttachments: true,
                            },
                          )
                        : previousWrite
                          ? await onSave(recordData, previousWrite.record)
                          : await onSave(recordData);
                    }
                    if (saved) {
                      confirmedWrite.current = {
                        record: saved,
                        payload,
                        fields: fieldValues,
                        pendingAttachments:
                          temporary.length > 0 || attachments.length > 0,
                      };
                      setSavedRecordId(saved.id);
                    }
                    if (temporary.length) {
                      if (!saved || !onPersistTemporaryAttachments)
                        throw new Error(
                          t(
                            "No se pudieron asociar los archivos al registro. Inténtalo de nuevo.",
                          ),
                        );
                      await onPersistTemporaryAttachments(saved, temporary);
                      queuedAttachmentsRef.current = {};
                      setQueuedAttachments({});
                      replaceTemporaryAttachments([]);
                      setAttachmentVersion((version) => version + 1);
                    } else if (attachments.length) {
                      if (!saved || !onPersistAttachments)
                        throw new Error(
                          t(
                            "No se pudieron preparar los archivos para R2. Guarda el registro e inténtalo de nuevo.",
                          ),
                        );
                      await onPersistAttachments(
                        saved,
                        attachments,
                        updateAttachmentStatus,
                      );
                    }
                    if (confirmedWrite.current)
                      confirmedWrite.current.pendingAttachments = false;
                    onSaved?.(saved);
                  } catch (e) {
                    if (!(
                      !cancelledRef.current &&
                      e instanceof TemporaryAttachmentUnavailableError &&
                      restartTemporaryUploads([e.attachmentId])
                    ))
                      setError((e as Error).message);
                  } finally {
                    submittedAttachments.current = undefined;
                    setBusy(false);
                    setUploadingAttachments({});
                  }
                }}
                renderSubmitButton={({ onSubmit, isSubmitting }) => (
                  <div
                    className={
                      "wizard-actions" +
                      (!activeStep ? " standard-form-actions" : "")
                    }
                  >
                    {formActions}
                    {!activeStep && onCancel && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || isSubmitting}
                        onClick={cancel}
                      >
                        {t("Cancelar")}
                      </Button>
                    )}
                    {activeStep && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || isSubmitting || activeIndex === 0}
                        onClick={() => goBack(activeIndex - 1)}
                      >
                        <ArrowLeft size={14} aria-hidden="true" />
                        {t("Anterior")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      onClick={onSubmit}
                      disabled={
                        busy || isSubmitting || hasPendingAttachmentUpload
                      }
                      className="form-submit"
                    >
                      {busy ? (
                        <LoaderCircle
                          className="animate-spin"
                          size={14}
                          aria-hidden="true"
                        />
                      ) : lastStep ? (
                        <Save size={14} aria-hidden="true" />
                      ) : (
                        <ArrowRight size={14} aria-hidden="true" />
                      )}
                      {busy
                        ? t("Guardando…")
                        : lastStep
                          ? submitLabel
                          : t("Siguiente paso")}
                    </Button>
                    {activeStep && (
                      <p className="wizard-save-note">
                        {t("Se guardará al completar el último paso.")}
                      </p>
                    )}
                  </div>
                )}
              />
            </InjectedFieldProvider>
          </RulesEngineProvider>
        </AttachmentQueueProvider>
      </WizardContext.Provider>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
