import { z } from "zod";

const unavailable = "This capability is not included in this Savia release.";

export type AssistantQuoteInput = {
  vehicle: {
    plate: string;
    referenceCode: string;
    productionYear: number;
    isNew: boolean;
    circulationCity: string;
    accessoriesValue: number;
    declaredValue: number;
  };
  applicant: {
    documentType: "CC" | "CE";
    documentNumber: string;
    firstName: string;
    surname: string;
    secondSurname?: string;
    gender: "F" | "M";
    birthDate: string;
    city: string;
    address: string;
    phone: string;
    email: string;
  };
};

/** Safe schema boundary for assistant features supplied by optional releases. */
export const assistantQuoteInputSchema = z.custom<AssistantQuoteInput>(
  () => false,
  { error: unavailable },
);

export const assistantQuoteForm = {
  domain: "optional",
  command: "unavailable",
  groups: [],
  instructions: unavailable,
} as const;
