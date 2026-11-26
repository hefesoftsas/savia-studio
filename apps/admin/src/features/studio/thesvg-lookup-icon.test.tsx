import { render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  ThesvgLookupIcon,
  thesvgIconLoaderCount,
} from "@/features/studio-engine/thesvg-lookup-icon";

it("loads a brand icon from the @thesvg catalog", async () => {
  expect(thesvgIconLoaderCount).toBeGreaterThan(1000);
  const { container } = render(
    <ThesvgLookupIcon name="hubspot" className="brand-icon" />,
  );
  await waitFor(() => {
    expect(container.querySelector("svg.brand-icon")).toBeTruthy();
  });
});

it("clears the old brand icon while a replacement loads", async () => {
  const { container, rerender } = render(
    <ThesvgLookupIcon name="github" className="brand-icon" />,
  );
  await waitFor(() =>
    expect(container.querySelector("svg.brand-icon")).toBeInTheDocument(),
  );
  rerender(<ThesvgLookupIcon name="gitlab" className="brand-icon" />);
  expect(container.querySelector("svg.brand-icon")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(container.querySelector("svg.brand-icon")).toBeInTheDocument(),
  );
});
