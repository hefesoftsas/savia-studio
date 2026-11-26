import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  getSessionGeneration,
  useSessionGeneration,
} from "@/auth/session-scope";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SaviaRequestApi } from "../savia-request-api";
import type { RequestFlow } from "../types";

type DeleteAction = {
  title: string;
  description: string;
  confirmLabel?: string;
  run(): void | Promise<void>;
};

type DeleteRequest = Omit<DeleteAction, "run"> & {
  run(isCurrent: () => boolean): void | Promise<void>;
};

export function useDeleteConfirmation(
  api: SaviaRequestApi,
  active: boolean,
  draft?: RequestFlow | null,
) {
  const location = useLocation();
  const sessionGeneration = useSessionGeneration();
  const flowId = draft?.id;
  const scope = useMemo(
    () => ({ api, active, location, sessionGeneration, flowId }),
    [api, active, location, sessionGeneration, flowId],
  );
  type Target = { scope: typeof scope; draft: typeof draft };
  const committed = useRef<Target | null>(null);
  const [pending, setPending] = useState<Target & { action: DeleteAction }>();

  useLayoutEffect(() => {
    committed.current = { scope, draft };
    setPending((current) =>
      current?.scope === scope && current.draft === draft ? current : undefined,
    );
    return () => {
      committed.current = null;
    };
  }, [scope, draft]);

  const isCurrent = () =>
    scope.active &&
    committed.current?.scope === scope &&
    scope.sessionGeneration === getSessionGeneration();

  const confirmDeletion = ({ run, ...details }: DeleteRequest) => {
    if (!isCurrent()) return;
    setPending({
      scope,
      draft,
      action: {
        ...details,
        run: () => {
          if (isCurrent() && committed.current?.draft === draft)
            return run(isCurrent);
        },
      },
    });
  };

  return {
    deletion:
      pending?.scope === scope && pending.draft === draft
        ? pending.action
        : undefined,
    confirmDeletion,
    closeDeletion: () =>
      setPending((current) => (current === pending ? undefined : current)),
  };
}

export function DeleteDialog({
  action,
  onClose,
}: {
  action: DeleteAction;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.title}</DialogTitle>
          <DialogDescription>{action.description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            Cancelar
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await action.run();
                onClose();
              } catch (exception) {
                setError(
                  exception instanceof Error
                    ? exception.message
                    : "No se pudo completar la operación.",
                );
                setBusy(false);
              }
            }}
            type="button"
            variant="destructive"
          >
            {busy
              ? action.confirmLabel
                ? "Procesando…"
                : "Eliminando…"
              : (action.confirmLabel ?? "Eliminar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
