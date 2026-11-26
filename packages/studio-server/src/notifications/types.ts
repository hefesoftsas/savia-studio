import { dialectFor } from "@savia/db/dialect";
import { storedNoticeEventSchema } from "@savia/studio-shared/notifications";
import type {
  InboxPage,
  InboxQuery,
  NoticeActionState,
  NoticeEventInput,
  NoticeScope,
  NoticeSource,
  NoticeView,
} from "@savia/studio-shared/notifications";

export type { InboxPage, InboxQuery, NoticeActionState, NoticeEventInput, NoticeScope, NoticeSource, NoticeView };

export function boundTextArrayRows(db: D1Database): string {
  return dialectFor(db).name === "postgres"
    ? "jsonb_array_elements_text(?::jsonb) AS input_ids(value)"
    : "json_each(?)";
}

export function parseStoredNotice(payload: string): NoticeEventInput | undefined {
  try {
    const parsed = storedNoticeEventSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function noticeActionSql(db: D1Database) {
  const postgres = dialectFor(db).name === "postgres";
  const payload = postgres
    ? "(CASE WHEN e.payload IS JSON THEN e.payload::jsonb END)"
    : "(CASE WHEN json_valid(e.payload) THEN e.payload END)";
  const sourceKind = postgres
    ? `${payload} #>> '{source,kind}'`
    : `json_extract(${payload},'$.source.kind')`;
  const sourceId = postgres
    ? `${payload} #>> '{source,id}'`
    : `json_extract(${payload},'$.source.id')`;
  const requiresAcknowledgement = postgres
    ? `(${payload} -> 'requireAcknowledgement') = 'true'::jsonb`
    : `json_type(${payload},'$.requireAcknowledgement')='true'`;
  const pendingAcknowledgement = `((${sourceKind})='admin-message'
    AND ${requiresAcknowledgement} AND d.resolved_at IS NULL)`;
  return { sourceKind, sourceId, pendingAcknowledgement };
}

export interface DeliveryRow {
  id: string;
  event_id: string;
  scope_kind: string;
  scope_id: string;
  recipient_id: string;
  created_at: number;
  read_at: number | null;
  archived_at: number | null;
  resolved_at: number | null;
}

export function stableEventId(input: NoticeEventInput): string {
  const seed = `${input.scope.kind}|${input.scope.id}|${input.key}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `ntf_${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortValue(v)]),
    );
  }
  return value;
}

export function canonicalPayload(input: NoticeEventInput): string {
  return JSON.stringify(sortValue(input));
}

export function encodeCursor(createdAt: number, id: string): string {
  // Escape non-Latin-1 code units and keep the existing base64 JSON format.
  const json = JSON.stringify([createdAt, id]).replace(
    /[\u0100-\uFFFF]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return btoa(json)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodeCursor(cursor: string): [number, string] | null {
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const parts: unknown = JSON.parse(
      atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
    );
    if (!Array.isArray(parts) || parts.length !== 2) return null;
    const [createdAt, id] = parts;
    if (Number.isSafeInteger(createdAt) && typeof id === "string" && id !== "")
      return [createdAt, id];
    return null;
  } catch {
    return null;
  }
}
