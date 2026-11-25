/** Explicit generic package adoption for tests; production installs none. */
export async function installExampleSolutionFixture(
  db: D1Database,
  ...tenants: string[]
) {
  for (const tenant of tenants) {
    await db
      .prepare(
        "INSERT INTO studio_solution_installations(tenant_id,id,version,enabled,manifest) VALUES (?, 'example.projects', '1.0.0', 1, ?) ON CONFLICT(tenant_id,id) DO UPDATE SET enabled=1",
      )
      .bind(
        tenant,
        JSON.stringify({
          format: "savia.solution",
          formatVersion: 1,
          id: "example.projects",
          version: "1.0.0",
          label: "Example projects",
          description: "A generic solution fixture for platform tests.",
          requires: [],
          objects: [],
        }),
      )
      .run();
  }
}
