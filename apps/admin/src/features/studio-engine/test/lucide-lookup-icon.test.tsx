import { render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { LucideLookupIcon } from "../lucide-lookup-icon";

it("clears the previous icon immediately when the selected icon changes", async () => {
  const { container, rerender } = render(
    <LucideLookupIcon name="arrow-left" />,
  );
  await waitFor(() =>
    expect(container.querySelector("svg")).toHaveClass("lucide-arrow-left"),
  );

  rerender(<LucideLookupIcon name="arrow-right" />);
  expect(container.querySelector(".lucide-arrow-left")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(container.querySelector("svg")).toHaveClass("lucide-arrow-right"),
  );

  rerender(<LucideLookupIcon name="not-a-lucide-icon" />);
  expect(container.querySelector("svg")).not.toBeInTheDocument();

  rerender(<LucideLookupIcon name="arrow-left" />);
  expect(container.querySelector("svg")).toHaveClass("lucide-arrow-left");
});

it("renders a legacy Lucide alias using its canonical icon", async () => {
  const { container } = render(<LucideLookupIcon name="arrow-down-az" />);
  await waitFor(() =>
    expect(container.querySelector("svg")).toHaveClass("lucide-arrow-down-a-z"),
  );
});

it("keeps the sidebar fallback until its configured icon loads", async () => {
  const fallback = <span data-testid="default-icon" />;
  const { container, getByTestId, rerender } = render(
    <LucideLookupIcon name="not-a-lucide-icon" fallback={fallback} />,
  );
  expect(getByTestId("default-icon")).toBeInTheDocument();

  rerender(
    <LucideLookupIcon name="circle-question-mark" fallback={fallback} />,
  );
  expect(getByTestId("default-icon")).toBeInTheDocument();
  await waitFor(() =>
    expect(container.querySelector("svg")).toHaveClass(
      "lucide-circle-question-mark",
    ),
  );
  expect(container.querySelector("[data-testid=default-icon]")).toBeNull();
});
