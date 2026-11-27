import { expect, it } from "vitest";
import type { AccessPolicy } from "@savia/studio-shared/access-control";
import { makeConfig, type StudioObject } from "@savia/studio-shared/metadata";
import { visibleAccessObject } from "../src/access-middleware";

it("only projects scoped deletion for native record storage", () => {
  const policy: AccessPolicy = {
    principalId: "operator",
    scope: "tenant:10",
    revision: 1,
    grants: [
      {
        id: "delete-record",
        roleId: "operators",
        action: "delete",
        resource: "collection:contacts",
        predicate: { all: true },
        fields: [],
      },
    ],
  };
  const native: StudioObject = {
    name: "contacts",
    label: "Contacts",
    description: "",
    config: makeConfig({ name: { type: "Textbox", label: "Name" } }),
  };
  const managed: StudioObject = {
    ...native,
    config: { ...native.config, studio: { business: "managed-customer" } },
  };
  expect(
    visibleAccessObject(policy, native).config.studio?.capabilities?.delete,
  ).toBe(true);
  expect(
    visibleAccessObject(policy, managed).config.studio?.capabilities?.delete,
  ).toBe(false);
});
