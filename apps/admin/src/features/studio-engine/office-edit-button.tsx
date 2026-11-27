import { useOfficeAvailability } from "@/features/office-settings/office-availability";
import { useMessages } from "@/i18n/core";
import { recordsMessages } from "@/i18n/locales/records";
import { FilePenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { officeFormat, OFFICE_MAX_SIZE } from "@savia/studio-shared/office";
import { officeEditorUrl } from "../office/office-api";
import { getStudioRuntime } from "./runtime";
export function OfficeEditButton({
  file,
  disabled = false,
}: {
  file: { id: string; name: string; mime: string; size: number };
  disabled?: boolean;
}) {
  const office = useOfficeAvailability();
  const t = useMessages(recordsMessages);

  const url = officeEditorUrl(getStudioRuntime().apiBasePath, file.id);
  if (
    !office.enabled ||
    !url ||
    !officeFormat(file.name, file.mime) ||
    file.size > OFFICE_MAX_SIZE ||
    disabled
  )
    return null;
  return (
    <Button variant="ghost" size="icon" asChild>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("Abrir %{p0} en Office", { p0: file.name })}
        title={t("Abrir en Office")}
      >
        <FilePenLine size={16} aria-hidden="true" />
      </a>
    </Button>
  );
}
