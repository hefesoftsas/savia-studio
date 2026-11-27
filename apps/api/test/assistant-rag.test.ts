import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunkText,
  extractTextFromFile,
  indexDocument,
  retrieveRelevantChunks,
  deleteFileVectors,
} from "../src/assistant/rag";

const migrationSqls = Object.entries(
  import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([, sql]) => sql);

function migrationStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .replace(/^--.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

async function applyMigrations() {
  for (const migration of migrationSqls) {
    for (const statement of migrationStatements(migration)) {
      await env.DB.exec(statement);
    }
  }
}

describe("Assistant RAG", () => {
  beforeAll(applyMigrations);

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM assistant_virtual_employee_chunks");
    await env.DB.exec("DELETE FROM assistant_virtual_employee_files");
  });

  describe("chunkText", () => {
    it("returns empty array for empty or whitespace text", () => {
      expect(chunkText("")).toEqual([]);
      expect(chunkText("   \n\n   ")).toEqual([]);
    });

    it("splits long text by paragraphs with overlap", () => {
      const p1 = "Este es el primer párrafo de las políticas del proveedor para vehículos.";
      const p2 = "Este es el segundo párrafo con detalles de cotizaciones y tarifas comerciales.";
      const p3 = "Este es el tercer párrafo que describe las exclusiones generales de la contrato.";
      const full = `${p1}\n\n${p2}\n\n${p3}`;

      const chunks = chunkText(full, 120, 30);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]).toContain("primer párrafo");
    });
  });

  describe("extractTextFromFile", () => {
    it("extracts text from plain string or text buffer", () => {
      const text = "Reglas de suscripción 2026";
      const buffer = new TextEncoder().encode(text).buffer;
      expect(extractTextFromFile(buffer, "text/plain", "reglas.txt")).toBe(text);
    });

    it("extracts and formats JSON content", () => {
      const data = { condicion: "amplia", cargo: 5 };
      const jsonStr = JSON.stringify(data);
      const buffer = new TextEncoder().encode(jsonStr).buffer;
      const extracted = extractTextFromFile(buffer, "application/json", "condiciones.json");
      expect(extracted).toContain('"condicion": "amplia"');
    });
  });

  describe("indexing and retrieval", () => {
    it("indexes document chunks and retrieves relevant content by keyword", async () => {
      const employeeId = "emp-default-ventas";
      const fileId = "file-123";

      // Insert dummy file first for foreign key
      await env.DB.prepare(
        `INSERT INTO assistant_virtual_employee_files (id, employee_id, name, content_type, size_bytes, r2_key, rag_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(fileId, employeeId, "tarifas.md", "text/markdown", 100, "r2/key", "indexed", new Date().toISOString())
        .run();

      const docText = `
        Tarifas y cotizaciones 2026 para pedidos comerciales.
        Para cotizar un pedido comercial se requiere el número de orden y la identificación del solicitante.
        La tarifa de entrega depende del destino.

        Políticas de Descuentos Especiales:
        Los pedidos de más de 3 unidades tienen un 15% de descuento en el precio final.
      `;

      const result = await indexDocument(
        { DB: env.DB },
        employeeId,
        fileId,
        docText,
      );

      expect(result.chunksCount).toBeGreaterThan(0);

      // Verify retrieval for quantity discounts
      const chunks = await retrieveRelevantChunks(
        { DB: env.DB },
        employeeId,
        "descuento por cantidad de unidades",
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].text).toContain("descuento en el precio final");
    });

    it("keeps document search local when legacy AI bindings are present", async () => {
      const employeeId = "emp-default-ventas";
      const fileId = "file-mock-ai";

      await env.DB.prepare(
        `INSERT INTO assistant_virtual_employee_files (id, employee_id, name, content_type, size_bytes, r2_key, rag_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(fileId, employeeId, "manual.txt", "text/plain", 50, "r2/manual", "indexed", new Date().toISOString())
        .run();

      const mockEmbedding = vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] });
      const mockInsert = vi.fn();
      const mockQuery = vi.fn().mockResolvedValue({ matches: [] });
      const bindings = {
        DB: env.DB,
        AI: { run: mockEmbedding },
        VECTORIZE: {
          insert: mockInsert,
          query: mockQuery,
          deleteByIds: vi.fn(),
        },
      };

      await indexDocument(
        bindings,
        employeeId,
        fileId,
        "Manual operativo sobre entregas urgentes.",
      );

      const matches = await retrieveRelevantChunks(
        bindings,
        employeeId,
        "entregas urgentes",
      );

      expect(matches.map((chunk) => chunk.text)).toEqual([
        "Manual operativo sobre entregas urgentes.",
      ]);
      expect(mockEmbedding).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each(["pending", "failed"])(
      "excludes saved chunks while a file is %s",
      async (status) => {
        const employeeId = "emp-default-ventas";
        const fileId = "file-incomplete";
        const text = "Manual de entregas urgentes.";
        await env.DB.prepare(
          `INSERT INTO assistant_virtual_employee_files (id, employee_id, name, content_type, size_bytes, r2_key, rag_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            fileId,
            employeeId,
            "manual.txt",
            "text/plain",
            text.length,
            "r2/manual",
            status,
            new Date().toISOString(),
          )
          .run();
        await indexDocument({ DB: env.DB }, employeeId, fileId, text);

        expect(
          await retrieveRelevantChunks({ DB: env.DB }, employeeId, "entregas"),
        ).toEqual([]);

        await env.DB.prepare(
          "UPDATE assistant_virtual_employee_files SET rag_status = 'indexed' WHERE id = ?",
        )
          .bind(fileId)
          .run();
        expect(
          await retrieveRelevantChunks({ DB: env.DB }, employeeId, "entregas"),
        ).toMatchObject([{ fileId, text }]);
      },
    );

    it("deletes file vectors and chunks", async () => {
      const employeeId = "emp-default-ventas";
      const fileId = "file-to-delete";

      await env.DB.prepare(
        `INSERT INTO assistant_virtual_employee_files (id, employee_id, name, content_type, size_bytes, r2_key, rag_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(fileId, employeeId, "delete.txt", "text/plain", 10, "r2/del", "indexed", new Date().toISOString())
        .run();

      await indexDocument(
        { DB: env.DB },
        employeeId,
        fileId,
        "Contenido que será eliminado.",
      );

      await deleteFileVectors({ DB: env.DB }, employeeId, fileId);

      const chunks = await retrieveRelevantChunks(
        { DB: env.DB },
        employeeId,
        "eliminado",
      );
      expect(chunks).toHaveLength(0);
    });
  });
});
