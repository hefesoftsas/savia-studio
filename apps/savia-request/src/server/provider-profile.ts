import type { Flow, Step, Variable } from "./types";

// The hosted plugin release supplies its provider policies during assembly.
export function isBundleFlow(_flow: Flow): boolean {
  return false;
}

export function isSimulatedQuote(_flow: Flow): boolean {
  return false;
}

export function simulateQuote(_flow: Flow): Record<string, unknown> {
  return { simulated: true };
}

export function simulateProviderResponse(
  _flow: Flow,
  _step: Step,
  _index: number,
  _values: Record<string, string>,
): Record<string, unknown> | null {
  return null;
}

export function simulateProviderVariable(
  _flow: Flow,
  variable: Variable,
): string {
  return variable.value;
}

export function legacyResultPrefix(_flow: Flow): string | null {
  return null;
}

export function providerActionLabel(_flow: Flow): string | null {
  return null;
}
