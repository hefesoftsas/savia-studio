/**
 * Cotizador form fixtures used by the Savia Request runtime tests.
 *
 * The admin `sample-request-quotes` screen that used to own these helpers was
 * removed; the live Savia Request flow consumes the same `sample_request.*`
 * variables, so the fixtures live with the test that exercises them.
 */
export const quoteProducts = [
  { id: "sample-producto-8", name: "SAMPLE · Product 8" },
  { id: "sample-producto-10", name: "SAMPLE · Gold" },
  { id: "sample-producto-11", name: "SAMPLE · Silver" },
];

const quoteFields = [
  "applicant.documentType",
  "applicant.documentNumber",
  "applicant.firstName",
  "applicant.surname",
  "applicant.secondSurname",
  "applicant.gender",
  "applicant.birthDate",
  "applicant.city",
  "applicant.address",
  "applicant.phone",
  "applicant.email",
  "vehicle.referenceCode",
  "vehicle.productionYear",
  "vehicle.isNew",
  "vehicle.circulationCity",
  "vehicle.plate",
  "vehicle.accessoriesValue",
  "vehicle.declaredValue",
] as const;

export function quoteInput(form: Record<string, string>) {
  return Object.fromEntries(
    quoteFields.map((key) => [
      "sample_request." + key,
      key === "vehicle.plate"
        ? form[key].trim().toUpperCase()
        : form[key].trim(),
    ]),
  );
}
