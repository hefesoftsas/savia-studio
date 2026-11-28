import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  translateMessage,
  useAppLocale,
  type MessageParams,
} from "@/i18n/core";
import { myDayStateMessages } from "./my-day-state-messages";
import type { UserPreferencesClient } from "@/api/user-preferences-client";
import { isReadAccessDenied } from "@/queries/read-state";
import {
  defaultMyDayWidgets,
  parseMyDayWidgets,
  type MyDayWidget,
  type MyDayWidgetsLayout,
} from "@savia/studio-shared/my-day-widgets";

let layoutCache = new WeakMap<UserPreferencesClient, MyDayWidgetsLayout>();
let layoutRevisions = new WeakMap<UserPreferencesClient, number>();
let layoutWrites = new WeakMap<UserPreferencesClient, Promise<boolean>>();
let sessionGeneration = 0;
type WidgetMessage = {
  key: keyof typeof myDayStateMessages;
  params?: MessageParams;
};
type WidgetFeedback = string | WidgetMessage | null;
const message = (
  key: WidgetMessage["key"],
  params?: MessageParams,
): WidgetMessage => ({ key, params });

function clearLayoutCache() {
  sessionGeneration += 1;
  layoutCache = new WeakMap();
  layoutRevisions = new WeakMap();
  layoutWrites = new WeakMap();
}

function nextLayoutRevision(client: UserPreferencesClient): number {
  const next = (layoutRevisions.get(client) ?? 0) + 1;
  layoutRevisions.set(client, next);
  return next;
}

if (typeof window !== "undefined") {
  window.addEventListener("savia:session-cleared", clearLayoutCache);
  window.addEventListener("savia:principal-changed", clearLayoutCache);
}

type LayoutScope = {
  client: UserPreferencesClient | undefined;
  generation: number;
};

type LayoutView = {
  scope: LayoutScope;
  layout: MyDayWidgetsLayout | undefined;
  reading: boolean;
  failed: boolean;
};

function startingView(scope: LayoutScope): LayoutView {
  return {
    scope,
    layout: scope.client
      ? layoutCache.get(scope.client)
      : defaultMyDayWidgets(),
    reading: Boolean(scope.client),
    failed: false,
  };
}

export function useMyDayWidgets(
  userPreferences: UserPreferencesClient | undefined,
) {
  const locale = useAppLocale();
  const [currentSessionGeneration, setCurrentSessionGeneration] =
    useState(sessionGeneration);
  const scope = useMemo(
    () => ({ client: userPreferences, generation: currentSessionGeneration }),
    [userPreferences, currentSessionGeneration],
  );
  const [view, setView] = useState(() => startingView(scope));
  const [writingScope, setWritingScope] = useState<LayoutScope>();
  const [feedbackState, setFeedback] = useState<WidgetFeedback>(null);
  const activeScope = useRef<LayoutScope | undefined>(undefined);
  const current = view.scope === scope ? view : startingView(scope);
  const { layout } = current;
  const saving = writingScope === scope;
  const canEdit = Boolean(layout) && !current.reading && !current.failed;

  useEffect(() => {
    const clear = () => {
      setFeedback(null);
      setCurrentSessionGeneration(sessionGeneration);
    };
    window.addEventListener("savia:session-cleared", clear);
    window.addEventListener("savia:principal-changed", clear);
    return () => {
      window.removeEventListener("savia:session-cleared", clear);
      window.removeEventListener("savia:principal-changed", clear);
    };
  }, []);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const { client, generation } = scope;
      const isCurrent = () =>
        !signal?.aborted &&
        activeScope.current === scope &&
        generation === sessionGeneration;
      if (!client || !isCurrent()) return;

      const pendingSave = layoutWrites.get(client);
      if (pendingSave) await pendingSave;
      if (!isCurrent()) return;

      setView(startingView(scope));
      const requestRevision = nextLayoutRevision(client);
      try {
        const next = parseMyDayWidgets(await client.getMyDayWidgets());
        if (!isCurrent() || layoutRevisions.get(client) !== requestRevision)
          return;
        layoutCache.set(client, next);
        setView({ scope, layout: next, reading: false, failed: false });
      } catch (error) {
        if (!isCurrent() || layoutRevisions.get(client) !== requestRevision)
          return;
        if (isReadAccessDenied(error)) layoutCache.delete(client);
        setView({
          scope,
          layout: layoutCache.get(client),
          reading: false,
          failed: true,
        });
      }
    },
    [scope],
  );

  useEffect(() => {
    activeScope.current = scope;
    const controller = new AbortController();
    void reload(controller.signal);
    return () => {
      controller.abort();
      activeScope.current = undefined;
    };
  }, [reload, scope]);

  const persist = useCallback(
    async (
      next: MyDayWidgetsLayout,
      successMessage: WidgetMessage["key"] | null,
    ) => {
      const { client, generation } = scope;
      const isCurrent = () =>
        activeScope.current === scope && generation === sessionGeneration;
      if (!canEdit || !isCurrent()) return false;
      if (!client) {
        setView({ scope, layout: next, reading: false, failed: false });
        if (successMessage) setFeedback(message(successMessage));
        return true;
      }
      if (layoutWrites.has(client)) return false;
      setWritingScope(scope);
      setFeedback(null);
      nextLayoutRevision(client);
      const operation = (async () => {
        try {
          const parsed = parseMyDayWidgets(await client.saveMyDayWidgets(next));
          if (generation !== sessionGeneration) return false;
          layoutCache.set(client, parsed);
          if (isCurrent()) {
            setView({ scope, layout: parsed, reading: false, failed: false });
            if (successMessage) setFeedback(message(successMessage));
          }
          return true;
        } catch {
          if (isCurrent()) {
            setView({
              scope,
              layout: layoutCache.get(client),
              reading: false,
              failed: false,
            });
            setFeedback(message("Could not save widgets. Try again."));
          }
          return false;
        }
      })();
      layoutWrites.set(client, operation);
      try {
        return await operation;
      } finally {
        if (layoutWrites.get(client) === operation) layoutWrites.delete(client);
        if (isCurrent()) setWritingScope(undefined);
      }
    },
    [canEdit, scope],
  );

  const add = useCallback(
    (widget: MyDayWidget) =>
      persist(
        {
          version: 1,
          widgets: [...(layout?.widgets ?? []), widget],
        },
        "Widget added to My Day.",
      ),
    [layout, persist],
  );

  const remove = useCallback(
    (id: string) =>
      persist(
        {
          version: 1,
          widgets: (layout?.widgets ?? []).filter((widget) => widget.id !== id),
        },
        "Widget removed.",
      ),
    [layout, persist],
  );

  const move = useCallback(
    (id: string, direction: -1 | 1) => {
      const widgets = layout?.widgets ?? [];
      const index = widgets.findIndex((widget) => widget.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= widgets.length)
        return Promise.resolve(false);
      const next = [...widgets];
      const [entry] = next.splice(index, 1);
      next.splice(target, 0, entry);
      return persist({ version: 1, widgets: next }, null);
    },
    [layout, persist],
  );

  const reorder = useCallback(
    (activeId: string, overId: string, visibleIds?: string[]) => {
      const all = layout?.widgets ?? [];
      const widgets = visibleIds
        ? all.filter((widget) => visibleIds.includes(widget.id))
        : all;
      const from = widgets.findIndex((widget) => widget.id === activeId);
      const to = widgets.findIndex((widget) => widget.id === overId);
      if (from < 0 || to < 0 || from === to) return Promise.resolve(false);
      const next = [...widgets];
      const [entry] = next.splice(from, 1);
      next.splice(to, 0, entry);
      let position = 0;
      const ordered = visibleIds
        ? all.map((widget) =>
            visibleIds.includes(widget.id) ? next[position++]! : widget,
          )
        : next;
      return persist({ version: 1, widgets: ordered }, null);
    },
    [layout, persist],
  );

  const hasSystemWidget = useCallback(
    (kind: "agenda" | "quick_task" | "mail" | "office_documents") =>
      (layout?.widgets ?? []).some((widget) => widget.kind === kind),
    [layout],
  );

  return {
    layout,
    widgets: layout?.widgets ?? [],
    loading: current.reading && !layout,
    refreshing: current.reading && Boolean(layout),
    readError: current.failed
      ? translateMessage(
          myDayStateMessages,
          "Could not load widgets. Try again.",
          locale,
        )
      : undefined,
    canEdit,
    saving,
    feedback:
      typeof feedbackState === "object" && feedbackState
        ? translateMessage(
            myDayStateMessages,
            feedbackState.key,
            locale,
            feedbackState.params,
          )
        : feedbackState,
    setFeedback,
    add,
    remove,
    move,
    reorder,
    hasSystemWidget,
    reload,
  };
}
