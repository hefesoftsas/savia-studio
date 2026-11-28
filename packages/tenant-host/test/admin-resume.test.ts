import { expect, it } from "vitest";
import { readAdminOAuthState, readAdminResume } from "../src/admin-resume";

it("preserves supported Studio navigation and drops unrelated query values", () => {
  const query =
    "tenantId=14&object=ventas&view=collection-sources&tab=sources&next=https://example.test&plugin.token=ignored";
  expect(readAdminResume("studio", query)).toEqual({
    route: "studio",
    query: "tenantId=14&object=ventas&view=collection-sources&tab=sources",
  });
  expect(readAdminResume("/admin/users", query)).toBeUndefined();
});

it("requires a workspace and collection for an opaque Studio record link", () => {
  const query = "object=ventas&view=records&record=record-14";
  expect(readAdminResume("studio", `tenantId=0&${query}`)?.query).toBe(
    `tenantId=0&${query}`,
  );
  expect(
    readAdminResume("studio", `tenantId=0&tenantId=14&${query}`)?.query,
  ).toBe("object=ventas&view=records");
  expect(readAdminResume("studio", "tenantId=14&record=record-14")?.query).toBe(
    "tenantId=14",
  );
});

it.each([
  "tenantId=14&object=ventas&view=remove-screen",
  "tenantId=14&object=ventas&view=records&configure=form",
])(
  "keeps a link to Studio's confirmation or configuration screen (%s)",
  (query) => {
    expect(readAdminResume("studio", query)?.query).toBe(query);
  },
);

it("parses Bookings and Studio route hints in OAuth state", () => {
  expect(
    readAdminOAuthState(
      "transaction.studio?tenantId=14&object=ventas&return_to=https%3A%2F%2Fdemo.example.test",
    ),
  ).toEqual({
    route: "studio",
    query: "tenantId=14&object=ventas",
    returnOrigin: "https://demo.example.test",
  });
  expect(
    readAdminOAuthState("transaction.bookings?tab=availability")?.query,
  ).toBe("tab=availability");
});
