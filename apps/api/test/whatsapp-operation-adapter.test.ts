import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createChannelOperationAdapter } from "../src/assistant/operation-adapter";
import { PersonalActionPayloadCipher } from "../src/assistant/personal-action-payload";
import { WhatsappChannelRepository } from "../src/whatsapp/channel-repository";
import { setupChannelFixture } from "./whatsapp-channel-fixture";

it("does not suggest AUTORIZO for an expired non-service action", async () => {
  const fixture = await setupChannelFixture();
  const repo = new WhatsappChannelRepository(env.DB);
  await repo.configure(
    fixture.tenantId,
    fixture.connectionId,
    {
      routingEnabled: true,
      tasks: [
        {
          id: "workspace",
          employeeId: fixture.employeeId,
          title: "Workspace help",
          description: "",
          order: 0,
          audiences: ["external"],
        },
      ],
      staff: [],
      internalCapabilities: [],
      externalCapabilities: [],
    },
    fixture.principal.id,
  );

  const access = await repo.getAccess({
    tenantId: fixture.tenantId,
    connectionId: fixture.connectionId,
    contact: "573001234567",
  });
  const menu = await repo.issueMenu(access);
  const session = (await repo.selectTask(access, "workspace", menu.id))!;
  const binding = (await fixture.repository.resolve(
    fixture.phoneNumberId,
    fixture.wabaId,
  ))!;

  const id = crypto.randomUUID();
  const sealedPayload = await new PersonalActionPayloadCipher(
    "test-secret",
  ).seal({
    actionId: id,
    principalId: session.access.principalId ?? session.access.contact,
    payload: { collection: "example" },
  });
  const actionJson = JSON.stringify({
    id,
    session,
    revision: 1,
    domain: "studio",
    command: "create-record",
    input: { sealedPayload },
  });
  await env.DB.prepare(
    "INSERT INTO whatsapp_channel_actions(id,connection_id,tenant_id,contact,generation,employee_id,selection_revision,action_json,token_hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,'expired',?,?)",
  )
    .bind(
      id,
      session.access.connectionId,
      session.access.tenantId,
      session.access.contact,
      session.access.generation,
      session.employeeId,
      session.selectionRevision,
      actionJson,
      "unused",
      new Date(Date.now() - 1000).toISOString(),
      new Date().toISOString(),
    )
    .run();
  const adapter = createChannelOperationAdapter({
    repository: repo,
    secret: "test-secret",
    backendForActor: async () => fetch,
  });

  const result = await adapter.capabilities(
    { ...binding, channelSession: session },
    { text: "Confirmar" } as any,
  );

  expect(result?.directReply).toMatch(/venció/i);
  expect(result?.directReply).toMatch(/menú/i);
  expect(result?.directReply).not.toMatch(/AUTORIZO/i);
});
