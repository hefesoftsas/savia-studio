// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { render as baseRender } from "@testing-library/react";
import { StoreContextProvider, memoryStore } from "ra-core";
import { AppLocaleProvider } from "@/i18n/app-locale-provider";
import SolutionManager from "../solution-manager";
import { api } from "../api";

vi.mock("../api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const manifest = {
  format: "savia.solution",
  formatVersion: 1,
  id: "savia.service",
  version: "1.5.0",
  label: "Servicios",
  description: "Modelos de servicios",
  labels: { en: "Service", pt: "Servicios" },
  descriptions: { en: "Service models" },
  requires: [],
  objects: [
    {
      name: "clientes",
      label: "Clientes",
      description: "Personas declaradas.",
      labels: { en: "Customers" },
      config: { version: 2, fields: {}, fieldOrder: [] },
    },
    {
      name: "contracts",
      label: "Contratos",
      description: "",
      config: { version: 2, fields: {}, fieldOrder: [] },
    },
  ],
};
// The preview response carries default labels only; the UI resolves
// translations from the posted candidate manifest.
const preview = {
  id: "savia.service",
  version: "1.5.0",
  objects: [
    { name: "clientes", label: "Clientes", action: "create" },
    { name: "contracts", label: "Contratos", action: "create" },
  ],
  conflicts: [],
  canInstall: true,
};

function renderWithLocale(locale: "es" | "en" | "pt") {
  vi.mocked(api).mockImplementation(async (url) => {
    if (url === "/solutions") return { data: [{ manifest, installed: null }] };
    if (url === "/solutions/activation-preview") return { data: preview };
    return { data: {} };
  });
  const store = memoryStore({ locale });
  baseRender(
    <StoreContextProvider value={store}>
      <AppLocaleProvider>
        <SolutionManager onChanged={vi.fn()} />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
}

it("shows translated package labels while keeping stored defaults", async () => {
  renderWithLocale("en");
  expect(await screen.findByText("Service")).toBeInTheDocument();
  expect(screen.queryByText("Servicios")).not.toBeInTheDocument();
});

it("resolves preview object labels from the candidate and falls back", async () => {
  renderWithLocale("en");
  fireEvent.click(
    await screen.findByRole("button", { name: "Enable Service" }),
  );
  expect(await screen.findByText("Customers")).toBeInTheDocument();
  // "Contratos" has no English override, so the default label is preserved.
  expect(screen.getByText("Contratos")).toBeInTheDocument();
});

it("keeps Spanish defaults when translations are absent", async () => {
  renderWithLocale("es");
  expect(await screen.findByText("Servicios")).toBeInTheDocument();
});
