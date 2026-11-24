import type { ServiceQuoteProgress } from "@savia/release-catalog/assistant-operations";
import { quoteFactsText } from "./quote-facts-text";

export function quoteProgressText(progress: ServiceQuoteProgress): string {
  if (
    progress.state !== "priced" ||
    typeof progress.premium !== "number" ||
    !Number.isFinite(progress.premium) ||
    progress.premium <= 0
  )
    return "";
  const facts = quoteFactsText(progress.facts, 8, 1600);
  return [
    `${progress.product}\nPrecio: $${progress.premium.toLocaleString("es-CO")}`,
    facts ? `Detalles verificados:\n${facts}` : "",
    facts && (progress.facts?.length ?? 0) > facts.split("\n").length
      ? "Los demás detalles estarán en el enlace de la cotización."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
