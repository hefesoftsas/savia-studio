import { fail } from "./context";

export type RecordCursorValue =
  | string
  | number
  | null
  | { rank: 0 | 1 | 2; number: string | number; text: string };
export type RecordCursor = { value: RecordCursorValue; id: string };
const MAX_CURSOR_TOKEN_LENGTH = 4096;

function validCursorText(value: string): boolean {
  if (value.length > 500) return false;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}

function validCursorNumber(value: unknown): value is string | number {
  if (typeof value === "number")
    return (
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
  return (
    typeof value === "string" &&
    value.length <= 3000 &&
    /^-?\d+(?:\.\d+)?$/.test(value)
  );
}

function validCursorValue(value: unknown): value is RecordCursorValue {
  if (value === null) return true;
  if (typeof value === "string") return validCursorText(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "number,rank,text"
  )
    return false;
  const { number, rank, text } = value as Record<string, unknown>;
  return (
    (rank === 0 || rank === 1 || rank === 2) &&
    validCursorNumber(number) &&
    typeof text === "string" &&
    validCursorText(text)
  );
}

export async function paginationScope(values: unknown[]): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(values)),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function encodeRecordCursor(
  scope: string,
  value: RecordCursorValue | undefined,
  id: string,
): string | null {
  if (!validCursorValue(value) || !validCursorText(id)) return null;
  const payload = new TextEncoder().encode(
    JSON.stringify({ scope, value, id }),
  );
  if (Math.ceil(payload.length / 3) * 4 > MAX_CURSOR_TOKEN_LENGTH) return null;
  return btoa(String.fromCharCode(...payload));
}
export function decodeRecordCursor(token: string, scope: string): RecordCursor {
  try {
    if (token.length > MAX_CURSOR_TOKEN_LENGTH) throw new Error();
    const data = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(token), (c) => c.charCodeAt(0)),
      ),
    );
    if (
      data.scope !== scope ||
      !validCursorValue(data.value) ||
      typeof data.id !== "string" ||
      !validCursorText(data.id)
    )
      throw new Error();
    return { value: data.value, id: data.id };
  } catch {
    return fail(
      "El cursor no corresponde a esta consulta. Recarga la lista.",
      422,
    );
  }
}
