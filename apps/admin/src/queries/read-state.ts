export type ReadState =
  | "initial"
  | "ready"
  | "refreshing"
  | "refresh-error"
  | "initial-error"
  | "blocked";

export function deriveReadState({
  scopeReady,
  hasData,
  fetching,
  error,
  accessDenied,
}: {
  scopeReady: boolean;
  hasData: boolean;
  fetching: boolean;
  error: unknown;
  accessDenied: boolean;
}): ReadState {
  if (!scopeReady || accessDenied) return "blocked";
  if (hasData) {
    if (fetching) return "refreshing";
    if (error != null) return "refresh-error";
    return "ready";
  }
  if (error != null) return "initial-error";
  return "initial";
}

function readErrorStatus(error: unknown) {
  return error && typeof error === "object"
    ? (error as { status?: unknown }).status
    : undefined;
}

export function isReadAuthenticationRequired(error: unknown): boolean {
  return readErrorStatus(error) === 401;
}

export function isReadAccessDenied(error: unknown): boolean {
  const status = readErrorStatus(error);
  return status === 401 || status === 403;
}
