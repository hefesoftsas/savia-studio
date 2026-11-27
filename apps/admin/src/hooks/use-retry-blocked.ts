import { useCallback, useEffect, useRef, useState } from "react";

export function retryIsBlocked(retryAt: number | undefined): boolean {
  return retryAt !== undefined && Date.now() < retryAt;
}

export function useRetryBlocked(retryAt: number | undefined): boolean {
  const [elapsedDeadline, setElapsedDeadline] = useState<number>();
  useEffect(() => {
    if (retryAt === undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    const waitForDeadline = () => {
      const remaining = retryAt - Date.now();
      if (remaining <= 0) setElapsedDeadline(retryAt);
      else
        timer = setTimeout(waitForDeadline, Math.min(remaining, 2_147_483_647));
    };
    waitForDeadline();
    return () => clearTimeout(timer);
  }, [retryAt]);
  return elapsedDeadline !== retryAt && retryIsBlocked(retryAt);
}

/** Share a deadline across requests, including callbacks that are already pending. */
export function useRetryDeadline() {
  const [retryAt, setRetryAt] = useState<number>();
  const latest = useRef<number | undefined>(undefined);
  const blocked = useRetryBlocked(retryAt);
  const remember = useCallback((deadline: number | undefined) => {
    if (deadline === undefined || deadline <= (latest.current ?? 0)) return;
    latest.current = deadline;
    setRetryAt(deadline);
  }, []);
  return {
    retryAt,
    blocked,
    remember,
    isBlockedNow: () => retryIsBlocked(latest.current),
  };
}
