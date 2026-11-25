import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FormProvider, useForm } from "react-hook-form";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserAccessRoles } from "./user-access-roles";
const get = vi.hoisted(() => vi.fn());
vi.mock("@/features/assistant/assistant-context", () => ({
  useAppServices: () => ({ apiClient: { get } }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function Harness({ roleIds = [] }: { roleIds?: string[] }) {
  const form = useForm({
    defaultValues: {
      tenantId: "3",
      platformAdmin: false,
      accessRoleIds: roleIds,
    },
  });
  return (
    <FormProvider {...form}>
      <UserAccessRoles />
      <button onClick={() => form.setValue("tenantId", "4")}>
        Change tenant
      </button>
      <output data-testid="selected">
        {form.watch("accessRoleIds").join(",")}
      </output>
    </FormProvider>
  );
}
it("loads enabled custom roles for the tenant and clears selections when it changes", async () => {
  get.mockImplementation(async (path: string) => ({
    revision: 1,
    roles: decodeURIComponent(path).includes("tenant:3")
      ? [
          { id: "test", label: "Test", protected: false, enabled: true },
          {
            id: "disabled",
            label: "Disabled role",
            protected: false,
            enabled: false,
          },
          {
            id: "admin",
            label: "System admin",
            protected: true,
            enabled: true,
          },
        ]
      : [],
  }));
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Harness />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: "Test" }));
  expect(screen.getByTestId("selected")).toHaveTextContent("test");
  expect(screen.queryByText("Disabled role")).toBeNull();
  expect(screen.queryByText("System admin")).toBeNull();
  fireEvent.click(screen.getByText("Change tenant"));
  await waitFor(() =>
    expect(screen.getByTestId("selected")).toBeEmptyDOMElement(),
  );
  expect(await screen.findByText(/No enabled custom roles/)).toBeVisible();
  expect(get).toHaveBeenCalledWith("/v1/access-control/roles?scope=tenant%3A4");
});

it("keeps the role selection within the API limit and allows swapping roles", async () => {
  const roles = Array.from({ length: 101 }, (_, index) => ({
    id: `role-${index}`,
    label: `Role ${index}`,
    protected: false,
    enabled: true,
  }));
  get.mockResolvedValue({ revision: 1, roles });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness roleIds={roles.slice(0, 99).map(({ id }) => id)} />
    </QueryClientProvider>,
  );
  const lastAllowed = await screen.findByRole("checkbox", { name: "Role 99" });
  const extra = screen.getByRole("checkbox", { name: "Role 100" });
  fireEvent.click(lastAllowed);
  expect(extra).toBeDisabled();
  expect(screen.getByText(/up to 100 custom roles/)).toBeVisible();
  expect(lastAllowed).not.toBeDisabled();
  fireEvent.click(lastAllowed);
  expect(extra).not.toBeDisabled();
  fireEvent.click(extra);
  expect(extra).toBeChecked();
  expect(lastAllowed).toBeDisabled();
});

it("removes disabled selections after a successful refresh and retains enabled roles", async () => {
  const first = {
    id: "first",
    label: "First role",
    protected: false,
    enabled: true,
  };
  const second = {
    id: "second",
    label: "Second role",
    protected: false,
    enabled: true,
  };
  get.mockResolvedValue({ revision: 1, roles: [first, second] });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: "First role" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Second role" }));
  expect(screen.getByTestId("selected")).toHaveTextContent("first,second");

  get.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["access-control", "roles", "tenant:3"],
    });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unable to load tenant roles.",
  );
  expect(screen.getByTestId("selected")).toHaveTextContent("first,second");

  get.mockResolvedValue({
    revision: 2,
    roles: [{ ...first, enabled: false }, second],
  });
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["access-control", "roles", "tenant:3"],
    });
  });
  await waitFor(() =>
    expect(screen.getByTestId("selected")).toHaveTextContent(/^second$/),
  );
  expect(screen.getByRole("checkbox", { name: "Second role" })).toBeChecked();
  expect(
    screen.queryByRole("checkbox", { name: "First role" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/no longer available/)).toHaveAttribute(
    "role",
    "status",
  );
});
