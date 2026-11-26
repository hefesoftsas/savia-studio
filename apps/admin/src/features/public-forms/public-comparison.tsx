import { intlLocale, useAppLocale, useMessages } from "@/i18n/core";
import { publicFormsMessages } from "@/i18n/locales/public-forms";
import { z } from "zod";

const quoteProjection = z.object({
  quotes: z.array(z.unknown()).max(20),
  unavailable: z.number().int().nonnegative(),
});

const publicQuote = z.object({
  flowId: z.string().optional(),
  provider: z.string(),
  product: z.string(),
  premiumTotal: z.number().finite().positive().max(1e12).nullable(),
  currency: z.literal("COP"),
});

export type PublicComparisonItem = {
  flowId: string;
  provider: string;
  product: string;
  premiumTotal: number | null;
  status: "succeeded" | "pending" | "failed";
};

export function PublicComparison({ items }: { items: PublicComparisonItem[] }) {
  const t = useMessages(publicFormsMessages);
  const locale = useAppLocale();
  if (!items.length) return null;
  const currency = new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "COP",
    currencyDisplay: "code",
  });
  const statuses = {
    succeeded: t("Consulta finalizada"),
    pending: t("En espera"),
    failed: t("Sin respuesta"),
  };
  return (
    <ul className="divide-y rounded-lg border bg-card text-left">
      {items.map((item) => (
        <li
          key={item.flowId}
          className="flex break-inside-avoid flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
        >
          <div className="min-w-0">
            <span className="block break-words font-medium">
              {item.provider}
            </span>
            <span className="block break-words text-sm text-muted-foreground">
              {item.product}
            </span>
          </div>
          <span className="text-sm tabular-nums">
            {item.premiumTotal === null
              ? statuses[item.status]
              : currency.format(item.premiumTotal)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Final receipt: projection quotes plus the unavailable note. */
export function PublicReceiptResult({ result }: { result: unknown }) {
  const t = useMessages(publicFormsMessages);
  const projection = quoteProjection.safeParse(result);
  if (!projection.success) return null;
  const { quotes } = projection.data;
  const items = quotes.flatMap((entry, index) => {
    const parsed = publicQuote.safeParse(entry);
    if (!parsed.success) return [];
    const quote = parsed.data;
    return [
      {
        flowId: quote.flowId ?? `quote-${index}`,
        provider: quote.provider,
        product: quote.product,
        premiumTotal: quote.premiumTotal,
        status: "succeeded" as const,
      },
    ];
  });
  const unavailable =
    projection.data.unavailable + quotes.length - items.length;
  return (
    <>
      <PublicComparison items={items} />
      {unavailable > 0 && (
        <p className="public-form-help">
          {t(
            unavailable === 1
              ? "%{count} resultado no está disponible."
              : "%{count} resultados no están disponibles.",
            { count: unavailable },
          )}
        </p>
      )}
    </>
  );
}

/** Defensive parse of the anonymous status endpoint: unknown shapes stay out. */
export function parseStatusItems(value: unknown): PublicComparisonItem[] {
  if (!Array.isArray(value)) return [];
  const items: PublicComparisonItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.flowId !== "string" || !record.flowId) continue;
    if (typeof record.label !== "string" || typeof record.provider !== "string")
      continue;
    const status =
      record.status === "done" ||
      record.status === "unavailable" ||
      record.status === "quoting"
        ? record.status
        : "waiting";
    const result =
      record.result &&
      typeof record.result === "object" &&
      !Array.isArray(record.result)
        ? (record.result as Record<string, unknown>)
        : undefined;
    const premium =
      result &&
      result.currency === "COP" &&
      typeof result.premiumTotal === "number" &&
      result.premiumTotal > 0 &&
      result.premiumTotal <= 1e12
        ? result.premiumTotal
        : null;
    items.push({
      flowId: record.flowId,
      provider: record.provider,
      product: record.label,
      premiumTotal: status === "done" ? premium : null,
      status:
        status === "done"
          ? "succeeded"
          : status === "unavailable"
            ? "failed"
            : "pending",
    });
  }
  return items;
}
