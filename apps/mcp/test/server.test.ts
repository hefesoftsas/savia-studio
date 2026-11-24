import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@prefecthq/fastmcp-ts/client";
import { createSaviaMcpServer } from "../src/server";
import { SaviaApiClient } from "../src/savia-api";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function startApi(
  handler: (request: IncomingMessage) => Promise<unknown>,
): Promise<string> {
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const payload = await handler(request);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("Savia FastMCP server", () => {
  it("does not expose optional release tools in the standalone server", async () => {
    const server = createSaviaMcpServer(
      new SaviaApiClient("https://api.test", "caller", async () =>
        Response.json({ data: [] }),
      ),
    );
    const client = await Client.connect(server);
    try {
      const tools = await client.listTools();
      expect(
        tools.some((tool) => tool.name.startsWith("savia_extension_")),
      ).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("exposes scoped CRM tools with usable write schemas", async () => {
    const server = createSaviaMcpServer(
      new SaviaApiClient("https://api.test", "caller", async () =>
        Response.json({ data: [] }),
      ),
    );
    const client = await Client.connect(server);
    try {
      const tools = await client.listTools();
      const studio = tools.filter((tool) =>
        /savia_(list_studio|(?:get|create|update|aggregate)_studio_record)/.test(
          tool.name,
        ),
      );
      expect(studio.map((tool) => tool.name).sort()).toEqual([
        "savia_aggregate_studio_records",
        "savia_create_studio_record",
        "savia_get_studio_record",
        "savia_get_studio_record_links",
        "savia_list_studio_collections",
        "savia_list_studio_records",
        "savia_update_studio_record",
      ]);
      // Legacy aliases stay registered for existing MCP clients.
      for (const legacy of [
        "savia_aggregate_crm_records",
        "savia_create_crm_record",
        "savia_get_crm_record",
        "savia_get_crm_record_links",
        "savia_list_crm_collections",
        "savia_list_crm_records",
        "savia_update_crm_record",
      ]) {
        expect(tools.some((tool) => tool.name === legacy)).toBe(true);
      }
      expect(
        tools.find((tool) => tool.name === "savia_update_studio_record")
          ?.inputSchema,
      ).toMatchObject({
        required: ["object", "id", "data"],
        properties: { data: { type: "object" } },
      });
      expect(
        studio
          .filter((tool) => !/create|update/.test(tool.name))
          .every((tool) => tool.annotations?.readOnlyHint),
      ).toBe(true);
      await expect(
        client.callTool("savia_create_studio_record", {
          object: "local",
          data: {},
        }),
      ).rejects.toThrow("not an installed Studio collection");
      await expect(
        client.callTool("savia_create_crm_record", {
          object: "local",
          data: {},
        }),
      ).rejects.toThrow("not an installed Studio collection");
    } finally {
      await client.close();
    }
  });
  it("exposes the domain API as tools, a resource, and an operating prompt", async () => {
    const apiUrl = await startApi(async (request) => {
      if (request.url === "/v1/domains") {
        return {
          data: [
            {
              id: "agency-network",
              collections: [],
              commands: [],
            },
          ],
        };
      }

      if (
        request.method === "POST" &&
        request.url === "/v1/agency-network/commands/create-agency"
      ) {
        expect(JSON.parse(await readBody(request))).toEqual({ name: "Savia" });
        return {
          document: {
            id: "900004",
            kind: "agencies",
            attributes: { name: "Savia" },
            relationships: {},
          },
        };
      }

      throw new Error(
        `Unexpected API request: ${request.method} ${request.url}`,
      );
    });

    const server = createSaviaMcpServer(new SaviaApiClient(apiUrl));
    const client = await Client.connect(server);

    try {
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "savia_execute_command",
          "savia_execute_personal_action",
          "savia_get_document",
          "savia_list_documents",
          "savia_list_domains",
          "savia_search_personal_files",
          "savia_search_personal_messages",
          "savia_list_personal_events",
          "savia_create_crm_record",
          "savia_update_crm_record",
          "savia_delete_crm_record",
        ]),
      );

      const domainResult = await client.callTool("savia_list_domains");
      expect(domainResult.structuredContent).toMatchObject({
        domains: [{ id: "agency-network" }],
      });

      const result = await client.callTool("savia_execute_command", {
        domain: "agency-network",
        command: "create-agency",
        input: { name: "Savia" },
      });
      expect(result.structuredContent).toMatchObject({
        document: { id: "900004", attributes: { name: "Savia" } },
      });

      const resources = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toContain(
        "savia://domains",
      );
      const domainResource = await client.readResource("savia://domains");
      expect("text" in (domainResource[0] ?? {})).toBe(true);
      expect((domainResource[0] as { text: string }).text).toContain(
        "agency-network",
      );

      const prompts = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toContain(
        "savia_operate_domain",
      );
    } finally {
      await client.close();
    }
  });

  it("uses credentials from each private MCP HTTP request to call the Domain API", async () => {
    let authorization: string | undefined;
    const apiUrl = await startApi(async (request) => {
      authorization = request.headers.authorization;
      if (request.url === "/v1/assistant/active-tenant") return { tenants: [] };
      expect(request.url).toBe("/v1/studio/0/api/objects");
      return { data: [] };
    });
    const server = createSaviaMcpServer({
      apiUrl,
      mcpSharedSecret: "internal-secret",
    });

    try {
      await server.run({
        transport: "http",
        host: "127.0.0.1",
        port: 0,
        stateless: true,
      });
      const address = server.address;
      if (!address) throw new Error("FastMCP HTTP server did not start");
      const client = await Client.connect({
        mcpServers: {
          savia: {
            url: `http://127.0.0.1:${address.port}${address.path}`,
            headers: {
              "x-savia-mcp-secret": "internal-secret",
              "x-savia-user-authorization": "Bearer delegated-user-token",
            },
          },
        },
      });

      try {
        await client.callTool("savia_list_crm_collections");
        expect(authorization).toBe("Bearer delegated-user-token");
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  });
});
