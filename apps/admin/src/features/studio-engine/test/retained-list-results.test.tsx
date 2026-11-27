import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { render } from "./locale-test-render";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ListContextProvider, useListContext } from "ra-core";
import { RetainedListResults } from "../retained-list-results";
afterEach(cleanup);
function Rows() {
  const { data, isPending } = useListContext();
  return (
    <div>
      {isPending
        ? "Loading"
        : (data?.map((r) => r.name).join(",") ?? "No rows")}
    </div>
  );
}
let client = new QueryClient();
function View({
  scope = "people",
  refetch = async () => {},
  ...value
}: {
  scope?: string;
  refetch?: () => Promise<unknown>;
  data?: { id: string; name: string }[];
  error?: Error;
  isPending?: boolean;
  isFetching?: boolean;
  isPlaceholderData?: boolean;
}) {
  return (
    <QueryClientProvider client={client}>
      <ListContextProvider
        value={
          {
            ...value,
            resource: scope,
            refetch,
            total: 1,
          } as never
        }
      >
        <RetainedListResults scope={scope}>
          <Rows />
        </RetainedListResults>
      </ListContextProvider>
    </QueryClientProvider>
  );
}
it("keeps successful rows visible after an interrupted page change and exposes retry", () => {
  const { rerender } = render(<View data={[{ id: "1", name: "Ana" }]} />);
  rerender(<View isPending isFetching />);
  expect(screen.getByText("Ana")).toBeVisible();
  rerender(<View error={new Error("No connection")} />);
  expect(screen.getByText("Ana")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("No connection");
  expect(screen.getByRole("button", { name: "Reintentar" })).toBeVisible();
});
it("blocks a manual retry until the rate limit expires", () => {
  vi.useFakeTimers();
  const refetch = vi.fn(async () => {});
  try {
    render(
      <View
        error={Object.assign(new Error("Rate limit"), {
          status: 429,
          retryAt: Date.now() + 30_000,
        })}
        refetch={refetch}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Puedes reintentar a partir de",
    );
    const retry = screen.getByRole("button", { name: "Reintentar" });
    act(() => vi.advanceTimersByTime(29_999));
    expect(retry).toBeDisabled();
    retry.click();
    expect(refetch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(retry).toBeEnabled();
    expect(refetch).not.toHaveBeenCalled();
    retry.click();
    expect(refetch).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it("does not reuse another collection or retain records after access is denied", () => {
  const { rerender } = render(<View data={[{ id: "1", name: "Ana" }]} />);
  rerender(<View scope="private" isPending />);
  expect(screen.queryByText("Ana")).not.toBeInTheDocument();
  rerender(<View data={[{ id: "1", name: "Ana" }]} />);
  rerender(
    <View error={Object.assign(new Error("Forbidden"), { status: 403 })} />,
  );
  expect(screen.queryByText("Ana")).not.toBeInTheDocument();
});

it.each(["reset", "remove"])(
  "keeps the visible page during a cache %s of an older page",
  async (operation) => {
    client = new QueryClient();
    const oldPage = ["people", "getList", { pagination: { page: 1 } }];
    const currentPage = ["people", "getList", { pagination: { page: 2 } }];
    const data = [{ id: "2", name: "Person on this page" }];
    client.setQueryData(oldPage, {
      data: [{ id: "1", name: "Earlier person" }],
      total: 2,
    });
    client.setQueryData(currentPage, { data, total: 2 });
    const { rerender } = render(<View data={data} />);
    expect(screen.getByText("Person on this page")).toBeVisible();

    await act(async () => {
      if (operation === "reset")
        await client.resetQueries({ queryKey: oldPage, exact: true });
      else client.removeQueries({ queryKey: oldPage, exact: true });
    });

    expect(screen.getByText("Person on this page")).toBeVisible();
    rerender(<View isFetching isPending />);
    expect(screen.getByText("Person on this page")).toBeVisible();
  },
);

it("clears retained and placeholder rows when the resource cache is reset or removed", async () => {
  for (const operation of ["reset", "remove"] as const) {
    client = new QueryClient();
    const data = [{ id: "1", name: "Revoked person" }];
    const key = ["people", "getList", {}];
    client.setQueryData(key, { data, total: 1 });
    const { rerender, unmount } = render(<View data={data} />);
    expect(screen.getByText("Revoked person")).toBeVisible();
    await act(async () => {
      if (operation === "reset") await client.resetQueries({ queryKey: key });
      else client.removeQueries({ queryKey: key });
    });
    expect(screen.queryByText("Revoked person")).not.toBeInTheDocument();
    rerender(<View data={data} isPlaceholderData isFetching />);
    expect(screen.queryByText("Revoked person")).not.toBeInTheDocument();
    rerender(<View error={new Error("Disconnected")} />);
    expect(screen.queryByText("Revoked person")).not.toBeInTheDocument();
    rerender(<View data={[{ id: "2", name: "Authorized person" }]} />);
    expect(screen.getByText("Authorized person")).toBeVisible();
    unmount();
  }
});

it("does not restore the same placeholder array after a denied refetch", () => {
  const data = [{ id: "secret", name: "Private person" }];
  const { rerender } = render(<View data={data} />);
  rerender(
    <View
      data={data}
      error={Object.assign(new Error("Forbidden"), { status: 403 })}
    />,
  );
  rerender(<View data={data} isPlaceholderData isFetching />);
  expect(screen.queryByText("Private person")).not.toBeInTheDocument();
});

it("accepts an authoritative refetch after denied access even when structural sharing reuses an array", async () => {
  client = new QueryClient();
  const data = [{ id: "1", name: "Restored person" }];
  const key = ["people", "getList", {}];
  client.setQueryData(key, { data, total: 1 });
  const { rerender } = render(<View data={data} />);
  rerender(
    <View
      data={data}
      error={Object.assign(new Error("Forbidden"), { status: 403 })}
    />,
  );
  rerender(<View data={data} isPlaceholderData isFetching />);
  await act(async () => {
    await client.fetchQuery({
      queryKey: key,
      queryFn: async () => ({ data, total: 1 }),
    });
  });
  rerender(<View data={data} />);
  expect(screen.getByText("Restored person")).toBeVisible();
});
