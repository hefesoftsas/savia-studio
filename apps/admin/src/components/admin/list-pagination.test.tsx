import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CoreAdminContext,
  ListBase,
  ListContextProvider,
  testDataProvider,
  type GetListParams,
  type RaRecord,
} from "ra-core";
import { afterEach, expect, it, vi } from "vitest";
import { ListPagination } from "./list-pagination";
import { createAppI18nProvider } from "@/lib/i18nProvider";

afterEach(cleanup);

it("can advance through an empty linked page with a continuation", async () => {
  const dataProvider = testDataProvider({
    getList: async <RecordType extends RaRecord>(
      _resource: string,
      params: GetListParams,
    ) => {
      const page = params.pagination?.page ?? 1;
      return {
        data: page === 2 ? [] : [{ id: String(page) } as RecordType],
        pageInfo: { hasPreviousPage: page > 1, hasNextPage: page < 3 },
      };
    },
  });
  render(
    <CoreAdminContext
      dataProvider={dataProvider}
      i18nProvider={createAppI18nProvider("es")}
    >
      <ListBase
        resource="linked_records"
        perPage={1}
        disableSyncWithLocation
        disableAuthentication
      >
        <ListPagination />
      </ListBase>
    </CoreAdminContext>,
  );
  fireEvent.click(
    await screen.findByRole("link", { name: "Página siguiente" }),
  );
  expect(await screen.findByText("0 resultados")).toBeVisible();
  expect(screen.getByRole("link", { name: "2" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  fireEvent.click(screen.getByRole("link", { name: "Página siguiente" }));
  expect(await screen.findByText("3-3 resultados")).toBeVisible();
  expect(screen.getByRole("link", { name: "3" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

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

it.each([true, false])(
  "shows the current page and counts only visible rows without a source total (has next: %s)",
  (hasNextPage) => {
    const setPage = vi.fn();
    render(
      <CoreAdminContext i18nProvider={createAppI18nProvider("es")}>
        <ListContextProvider
          value={
            {
              data: [{ id: "21" }, { id: "22" }],
              page: 3,
              perPage: 10,
              hasPreviousPage: true,
              hasNextPage,
              total: undefined,
              setPage,
            } as never
          }
        >
          <ListPagination />
        </ListContextProvider>
      </CoreAdminContext>,
    );
    expect(screen.getByRole("link", { name: "3" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByText(hasNextPage ? "21-22 de más de 22" : "21-22 resultados"),
    ).toBeVisible();
    const previous = screen.getByRole("link", { name: "Página anterior" });
    fireEvent.click(previous);
    expect(setPage).toHaveBeenLastCalledWith(2);
    if (hasNextPage) {
      fireEvent.click(screen.getByRole("link", { name: "Página siguiente" }));
      expect(setPage).toHaveBeenLastCalledWith(4);
    } else {
      expect(
        screen.queryByRole("link", { name: "Página siguiente" }),
      ).not.toBeInTheDocument();
    }
  },
);
