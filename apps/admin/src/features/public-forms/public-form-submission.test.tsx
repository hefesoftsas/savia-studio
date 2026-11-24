import { I18nContextProvider } from "ra-core";
import type { ReactElement, ReactNode } from "react";
import { cleanup, render as testingRender } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PublicReceiptResult } from "./public-comparison";

afterEach(cleanup);

function render(ui: ReactElement) {
  return testingRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nContextProvider
        value={{
          translate: (key: string) => key,
          changeLocale: async () => {},
          getLocale: () => "es",
        }}
      >
        {children}
      </I18nContextProvider>
    ),
  });
}

it("hides unknown receipt structures", () => {
  const { container } = render(<PublicReceiptResult result={{ nope: true }} />);
  expect(container).toBeEmptyDOMElement();
});
