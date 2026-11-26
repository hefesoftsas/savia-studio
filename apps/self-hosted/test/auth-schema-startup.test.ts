import { expect, it, vi } from "vitest";
import { createAuthHandler, initializeAuthSchema } from "../../auth/src/index";
import { SqliteDatabase } from "../src/sqlite";

function sqliteAuthFixture() {
  const database = new SqliteDatabase(":memory:");
  const origin = "http://127.0.0.1:8080";
  const environment = {
    AUTH_DB: database,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: crypto.randomUUID().repeat(2),
    BETTER_AUTH_BOOTSTRAP_EMAIL: "startup@example.test",
    BETTER_AUTH_BOOTSTRAP_PASSWORD: `Startup-${crypto.randomUUID()}!`,
    SAVIA_API_RESOURCE: origin,
  };
  return { database, environment, origin };
}

it.each(["startup", "schema initialization"] as const)(
  "validates the migrated SQLite database during %s",
  async (operation) => {
    const { database, environment, origin } = sqliteAuthFixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      if (operation === "startup") {
        const auth = createAuthHandler(environment, { database });
        const response = await auth.fetch(
          new Request(`${origin}/api/auth/get-session`),
        );
        expect(response.status).toBe(200);
      } else {
        await initializeAuthSchema(environment, { database });
      }
      const accountTable = await database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'account'")
        .first();
      expect(accountTable).toEqual({ name: "account" });
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining("Database schema mismatch"),
      );
    } finally {
      log.mockRestore();
      database.close();
    }
  },
);

it("rejects an incompatible required column after migration", async () => {
  const { database, environment } = sqliteAuthFixture();
  try {
    await initializeAuthSchema(environment, { database });
    await database.exec(
      'ALTER TABLE "account" ADD COLUMN "legacy_required_value" TEXT NOT NULL',
    );

    await expect(
      initializeAuthSchema(environment, { database }),
    ).rejects.toThrow(/legacy_required_value/);
  } finally {
    database.close();
  }
});
