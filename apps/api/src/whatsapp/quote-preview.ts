import { z } from "@hono/zod-openapi";
import { assistantQuoteInputSchema } from "@savia/release-catalog/assistant-contracts";

type QuotePreviewInput = Pick<
  z.infer<typeof assistantQuoteInputSchema>,
  "applicant"
>;

function inline(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function formatQuotePreview(
  input: QuotePreviewInput,
  productCount: number,
): string {
  const { applicant } = input;
  const fullName = [
    applicant.firstName,
    applicant.surname,
    applicant.secondSurname,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .map(inline)
    .join(" ");
  const count = Number.isFinite(productCount)
    ? Math.max(0, Math.floor(productCount))
    : 0;
  const productText =
    count === 1 ? "1 producto habilitado" : `${count} productos habilitados`;

  return [
    "Resumen de cotización",
    `Solicitante: ${fullName} · ${inline(applicant.documentType)} ${inline(applicant.documentNumber)}`,
    `Dirección: ${inline(applicant.address)} · Teléfono: ${inline(applicant.phone)}`,
    `Correo: ${inline(applicant.email)}`,
    `Consultaré ${productText}.`,
  ].join("\n");
}
