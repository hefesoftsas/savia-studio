import { cleanup, render, screen } from "@testing-library/react";
import { CoreAdminContext, ListContextProvider } from "ra-core";
import { afterEach, expect, it, vi } from "vitest";
import { ListPagination } from "./list-pagination";

afterEach(cleanup);

it("does not offer numbered pages beyond the source limit even when the total is higher", () => {
  render(
    <CoreAdminContext>
      <ListContextProvider
        value={
          {
            data: [{ id: "last" }],
            page: 100,
            perPage: 25,
            hasPreviousPage: true,
            hasNextPage: false,
            total: 5_000,
            setPage: vi.fn(),
          } as never
        }
      >
        <ListPagination maxPage={100} />
      </ListContextProvider>
    </CoreAdminContext>,
  );
  expect(screen.getByRole("link", { name: "100" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.queryByRole("link", { name: "200" })).not.toBeInTheDocument();
});
