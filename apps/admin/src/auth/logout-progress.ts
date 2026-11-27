import { useSyncExternalStore } from "react";

let pending = 0;
let signedOut = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getLogoutPending = () => pending > 0;
export const getSessionReadsPaused = () => getLogoutPending() || signedOut;

export function beginLogout(): (completed?: boolean) => void {
  pending += 1;
  notify();
  let finished = false;
  return (completed = false) => {
    if (finished) return;
    finished = true;
    pending -= 1;
    if (completed) signedOut = true;
    notify();
  };
}

export function resumeSessionReads(): void {
  if (!signedOut || getLogoutPending()) return;
  signedOut = false;
  notify();
}

export function useLogoutPending(): boolean {
  return useSyncExternalStore(subscribe, getLogoutPending, () => false);
}

/** Readers stay paused across the gap between logout cleanup and navigation. */
export function useSessionReadsPaused(): boolean {
  return useSyncExternalStore(subscribe, getSessionReadsPaused, () => false);
}
