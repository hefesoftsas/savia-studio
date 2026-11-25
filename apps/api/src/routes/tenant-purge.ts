import { dialectFor } from "@savia/db/dialect";
import {
  prepareForeignKeys,
  tableNames,
  type ForeignKey,
} from "../lib/database-schema";

type Table = {
  name: string;
  columns: string[];
  keys: ForeignKey[];
  predicate?: string;
};

const METADATA_BATCH_SIZE = 50;
export class TenantFileCleanupError extends Error {}

/** Schema-derived cleanup covers optional packages without assuming a business domain. */
export async function tenantPurgePlan(
  db: D1Database,
  id: number,
  companionKeys: readonly string[] = [],
) {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid tenant ID");
  const dialect = dialectFor(db);
  const quote = (name: string) => dialect.quoteIdentifier(name);
  let names = await tableNames(db);
  if (dialect.name === "sqlite") {
    // FTS shadow tables belong to their virtual table and must never be edited directly.
    const ordinary = await db
      .prepare("PRAGMA table_list")
      .all<{ name: string; type: string }>();
    const tables = new Set(
      ordinary.results
        .filter((row) => row.type === "table")
        .map((row) => row.name),
    );
    names = names.filter((name) => tables.has(name));
  }
  const tables: Table[] = [];
  // Each standalone PRAGMA also takes a backup-gate permit on Cloudflare.
  for (let offset = 0; offset < names.length; offset += METADATA_BATCH_SIZE) {
    const page = names.slice(offset, offset + METADATA_BATCH_SIZE);
    const [columns, keys] = await Promise.all([
      db.batch<{ name: string }>(
        page.map((name) => {
          const query = dialect.tableColumns(name);
          return db.prepare(query.sql).bind(...query.parameters);
        }),
      ),
      db.batch<ForeignKey>(page.map((name) => prepareForeignKeys(db, name))),
    ]);
    page.forEach((name, index) => {
      tables.push({
        name,
        columns: columns[index].results.map((column) => column.name),
        keys: keys[index].results,
      });
    });
  }
  const scoped = (column: string, numeric: boolean) => {
    const value = `CAST(${quote(column)} AS TEXT)`;
    return `(${value} IN (${numeric ? `'${id}',` : ""}'tenant:${id}') OR ${value} LIKE 'tenant:${id}:%')`;
  };
  for (const table of tables) {
    if (table.name === "tenants") {
      table.predicate = `id=${id}`;
      continue;
    }
    const predicates = table.columns
      .filter((column) =>
        [
          "tenant_id",
          "workspace_id",
          "agency_id",
          "context_tenant_id",
        ].includes(column),
      )
      .map((column) => scoped(column, true));
    if (table.columns.includes("scope"))
      predicates.push(scoped("scope", false));
    if (
      table.columns.includes("scope_kind") &&
      table.columns.includes("scope_id")
    )
      predicates.push(
        `(${quote("scope_kind")}='workspace' AND ${scoped("scope_id", false)})`,
      );
    if (predicates.length) table.predicate = predicates.join(" OR ");
  }
  const byName = new Map(tables.map((table) => [table.name, table]));
  const groups = (table: Table) => {
    const result = new Map<number, ForeignKey[]>();
    for (const key of table.keys) {
      const group = result.get(key.id) ?? [];
      group.push(key);
      result.set(key.id, group);
    }
    return [...result.values()];
  };
  // Unscoped descendants (file revisions, page revisions, employee files, etc.)
  // inherit ownership through their foreign key rather than through user ownership.
  let changed = true;
  while (changed) {
    changed = false;
    for (const table of tables) {
      if (table.predicate) continue;
      const inherited: string[] = [];
      for (const group of groups(table)) {
        const parent = byName.get(group[0].table);
        if (!parent?.predicate || parent === table) continue;
        inherited.push(
          `(${group.map((key) => quote(key.from)).join(",")}) IN (SELECT ${group.map((key) => quote(key.to ?? "id")).join(",")} FROM ${quote(parent.name)} WHERE ${parent.predicate})`,
        );
      }
      if (inherited.length) {
        table.predicate = inherited.join(" OR ");
        changed = true;
      }
    }
  }
  const ordered: Table[] = [],
    visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (table: Table) => {
    if (visited.has(table.name)) return;
    if (visiting.has(table.name))
      throw new Error("Cyclic tenant deletion dependency");
    visiting.add(table.name);
    for (const child of tables) {
      if (
        child !== table &&
        child.predicate &&
        child.keys.some((key) => key.table === table.name)
      )
        visit(child);
    }
    visiting.delete(table.name);
    visited.add(table.name);
    ordered.push(table);
  };
  // Delete subscriptions/workflows before records so deletion cannot dispatch work.
  for (const table of tables.filter(
    (table) => /^(notification_|workflow)/.test(table.name) && table.predicate,
  ))
    visit(table);
  for (const table of tables.filter((table) => table.predicate)) visit(table);
  const data = ordered.filter((table) => table.name !== "tenants");
  const statements = data.map((table) =>
    db.prepare(`DELETE FROM ${quote(table.name)} WHERE ${table.predicate}`),
  );
  // Record/ACL triggers may create tombstones or revisions after earlier deletes.
  const sweep = data
    .filter((table) =>
      table.columns.some((column) =>
        ["tenant_id", "workspace_id", "scope", "scope_id"].includes(column),
      ),
    )
    .map((table) =>
      db.prepare(`DELETE FROM ${quote(table.name)} WHERE ${table.predicate}`),
    );
  const keys = new Set(companionKeys);
  for (const table of data) {
    for (const column of table.columns.filter((column) =>
      ["storage_key", "object_key", "r2_key"].includes(column),
    )) {
      const rows = await db
        .prepare(
          `SELECT ${quote(column)} AS key FROM ${quote(table.name)} WHERE ${table.predicate}`,
        )
        .all<{ key: string }>();
      for (const row of rows.results) if (row.key) keys.add(row.key);
    }
  }
  // Some legacy key columns are not unique. Keep bytes still used outside
  // this tenant's deletion plan, including globally shared employee resources.
  const candidates = [...keys];
  for (const table of tables) {
    for (const column of table.columns.filter((column) =>
      ["storage_key", "object_key", "r2_key"].includes(column),
    )) {
      for (let offset = 0; offset < candidates.length; offset += 100) {
        const page = candidates.slice(offset, offset + 100);
        const outside = table.predicate
          ? `NOT COALESCE((${table.predicate}), FALSE)`
          : "1=1";
        const rows = await db
          .prepare(
            `SELECT ${quote(column)} AS key FROM ${quote(table.name)} WHERE ${quote(column)} IN (${page.map(() => "?").join(",")}) AND (${outside})`,
          )
          .bind(...page)
          .all<{ key: string }>();
        for (const row of rows.results) keys.delete(row.key);
      }
    }
  }
  return {
    statements: [
      ...statements,
      ...sweep,
      db
        .prepare("DELETE FROM tenants WHERE id=? AND kind='commercial'")
        .bind(id),
    ],
    keys: [...keys],
  };
}

export async function deleteTenantFiles(bucket: R2Bucket, keys: string[]) {
  if (!keys.length) return;
  try {
    for (let offset = 0; offset < keys.length; offset += 1000)
      await bucket.delete(keys.slice(offset, offset + 1000));
  } catch (cause) {
    throw new TenantFileCleanupError(
      "File cleanup failed. Retry tenant deletion.",
      {
        cause,
      },
    );
  }
}

/** Companion stores tenant ownership on R2 objects instead of in SQL. */
export async function tenantCompanionKeys(bucket: R2Bucket, id: number) {
  const keys = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  try {
    while (true) {
      const page = await bucket.list({
        prefix: "companion/",
        cursor,
        include: ["customMetadata"],
      });
      for (const object of page.objects) {
        if (object.customMetadata?.tenantId !== String(id)) continue;
        keys.add(object.key);
        if (
          object.key.startsWith("companion/samples/") &&
          object.key.endsWith(".ogg")
        )
          keys.add(object.key.replace(/\.ogg$/, ".notes.json"));
      }
      if (!page.truncated) break;
      if (!page.cursor || seenCursors.has(page.cursor))
        throw new Error(
          "Companion listing returned an invalid continuation cursor",
        );
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
  } catch (cause) {
    throw new TenantFileCleanupError(
      "Companion file listing failed. Retry tenant deletion.",
      {
        cause,
      },
    );
  }
  return [...keys];
}
