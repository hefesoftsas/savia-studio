import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "savia-initial-"));
  const file = join(dir, "db.sqlite");
  const shim = join(dir, "fetch.mjs");
  writeFileSync(
    shim,
    `import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(${JSON.stringify(file)});db.exec('PRAGMA foreign_keys=ON');
let concurrentBatchCommitted = false;
let overloadReported = false;
const overloaded = (code) => {
  const wait = process.env.D1_RETRY_AFTER;
  return Response.json({success:false, errors:[{code,message:'D1 request rejected'}]}, {
    status:429,
    ...(wait ? {headers:{'retry-after':wait}} : {}),
  });
};
if (process.env.STALL_D1_BODY === '1') {
  AbortSignal.timeout = () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    return controller.signal;
  };
}
globalThis.fetch=async (_url,options)=>{
  const {sql,batch}=JSON.parse(options.body);
  if (process.env.D1_READ_ONLY === '1' && (batch || !sql?.startsWith('SELECT ')))
    throw new Error('Migration status issued a write');
  const persistentOverload = process.env.D1_PERSISTENT_OVERLOAD === '1';
  if (sql?.startsWith('CREATE TABLE IF NOT EXISTS _savia_migrations') && process.env.D1_LEDGER_OVERLOAD && (!overloadReported || persistentOverload)) {
    overloadReported = true;
    if (persistentOverload) console.log('fixture: ledger request overloaded');
    return overloaded(Number(process.env.D1_LEDGER_OVERLOAD));
  }
  if (batch && process.env.D1_BATCH_OVERLOAD_ONCE === '1' && !overloadReported) {
    overloadReported = true;
    return overloaded(7429);
  }
  if (batch && process.env.D1_OVERLOAD_AFTER_BATCH === '1' && concurrentBatchCommitted && batch.at(-1).sql.includes('0001_initial.sql')) {
    throw new Error('already recorded migration was replayed');
  }
  if (batch && process.env.STALL_D1_BODY === '1') {
    if (!options.signal) throw new Error('no D1 request deadline');
    return {ok:true,json:()=>new Promise((_,reject)=>{
      options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
    })};
  }
  if (batch && process.env.REJECT_D1_STATEMENT === '1') {
    return {ok:true,status:200,json:async()=>({
      success:true,result:batch.map((_,index)=>({success:index!==0,results:[]}))
    })};
  }
  if (batch && process.env.INVALID_D1_ACK) {
    const result = batch.map(() => ({success:true,results:[]}));
    if (process.env.INVALID_D1_ACK === 'truncated') result.pop();
    else delete result.at(-1).success;
    return {ok:true,status:200,json:async()=>({success:true,result})};
  }
  if (batch && process.env.D1_NON_JSON_STATUS) {
    return new Response("<html>private upstream response</html>", {
      status: Number(process.env.D1_NON_JSON_STATUS),
      headers: {'content-type':'text/html'},
    });
  }
  try {
    if (batch) db.exec('BEGIN');
    const result = (batch ? batch.map(statement => statement.sql) : [sql]).map(statement => {
      if (process.env.FAIL_INITIAL === '1' && statement.includes('CREATE TRIGGER'))
        throw new Error('injected');
      return {results:db.prepare(statement).all(),success:true};
    });
    if (batch) db.exec('COMMIT');
    if (batch && process.env.D1_OVERLOAD_AFTER_BATCH === '1' && !concurrentBatchCommitted) {
      concurrentBatchCommitted = true;
      return overloaded(7429);
    }
    if (batch && process.env.CONCURRENT_D1_BATCH === '1' && !concurrentBatchCommitted) {
      concurrentBatchCommitted = true;
      return {ok:false,status:400,json:async()=>({
        success:false,errors:[{message:'table already exists'}]
      })};
    }
    return {ok:true,json:async()=>({success:true,result})};
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    return {ok:false,status:400,json:async()=>({
      success:false,errors:[{message:error.message}]
    })};
  }
};`,
  );
  return {
    file,
    close: () => rmSync(dir, { recursive: true, force: true }),
    run: (extra = {}, args = []) =>
      spawnSync(
        process.execPath,
        ["--import", shim, "scripts/apply-d1-migrations.mjs", ...args],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: "test",
            CLOUDFLARE_DATABASE_ID: "test",
            CLOUDFLARE_API_TOKEN: "test",
            ...extra,
          },
        },
      ),
  };
}

test("checking D1 distinguishes pending migrations, a matching history, and a database ahead of the checkout without writing", () => {
  const f = fixture();
  const previous = mkdtempSync(join(tmpdir(), "savia-before-migration-"));
  const files = readdirSync("packages/db/migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const latest = files.pop();
  try {
    for (const file of files)
      copyFileSync(join("packages/db/migrations", file), join(previous, file));
    const baseline = f.run({}, ["--migrations-dir", previous]);
    assert.equal(baseline.status, 0, baseline.stderr);

    const check = () => f.run({ D1_READ_ONLY: "1" }, ["--check"]);
    const pending = check();
    assert.equal(pending.status, 1);
    assert.match(pending.stderr, /D1 schema has pending Savia migrations/);
    const compatible = f.run({ D1_READ_ONLY: "1" }, [
      "--check",
      "--allow-pending",
    ]);
    assert.equal(compatible.status, 0, compatible.stderr);
    assert.match(
      compatible.stdout,
      /D1 schema has pending Savia migrations \(1\)/,
    );
    const db = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM _savia_migrations WHERE filename=?",
          )
          .get(latest).n,
        0,
      );
    } finally {
      db.close();
    }

    const upgrade = f.run();
    assert.equal(upgrade.status, 0, upgrade.stderr);
    const current = check();
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /D1 schema is up to date/);

    for (const options of [[], ["--allow-pending"]]) {
      const ahead = f.run({ D1_READ_ONLY: "1" }, [
        "--check",
        ...options,
        "--migrations-dir",
        previous,
      ]);
      assert.equal(ahead.status, 1, ahead.stdout);
      assert.match(
        ahead.stderr,
        /D1 migration history contains migrations missing from this checkout/,
      );
    }
  } finally {
    f.close();
    rmSync(previous, { recursive: true, force: true });
  }
});

test("checking an uninitialized D1 database leaves its migration history untouched", () => {
  const f = fixture();
  try {
    const result = f.run({ D1_READ_ONLY: "1" }, ["--check", "--allow-pending"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /D1 schema has pending Savia migrations/);
    const db = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema").all(), []);
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

test("recognizes the pre-applied assistant model migration without replaying it", () => {
  const f = fixture();
  try {
    const filename = "0039_assistant_allowed_models.sql";
    const db = new DatabaseSync(f.file);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(
      "CREATE TABLE _savia_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const file of readdirSync("packages/db/migrations")
      .filter((file) => file.endsWith(".sql") && file !== filename)
      .sort()) {
      db.exec(readFileSync(`packages/db/migrations/${file}`, "utf8"));
      db.prepare(
        "INSERT INTO _savia_migrations VALUES (?, 'already-applied')",
      ).run(file);
    }
    db.exec(
      "ALTER TABLE assistant_openrouter_settings ADD COLUMN allowed_models TEXT",
    );
    db.prepare(
      "INSERT INTO _savia_migrations VALUES (?, 'already-applied')",
    ).run(filename);
    db.exec("UPDATE tenants SET name='Preserved preview' WHERE id=0");
    const history = db
      .prepare("SELECT * FROM _savia_migrations ORDER BY filename")
      .all();
    db.close();
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const after = new DatabaseSync(f.file);
    assert.deepEqual(
      after.prepare("SELECT * FROM _savia_migrations ORDER BY filename").all(),
      history,
    );
    assert.equal(
      after.prepare("SELECT name FROM tenants WHERE id=0").get().name,
      "Preserved preview",
    );
    assert.equal(
      after
        .prepare("PRAGMA table_info(assistant_openrouter_settings)")
        .all()
        .filter((column) => column.name === "allowed_models").length,
      1,
    );
    assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    after.close();
  } finally {
    f.close();
  }
});

test("initial D1 schema and bootstrap apply once with intact triggers", () => {
  const f = fixture();
  try {
    const migrationCount = readdirSync("packages/db/migrations").filter(
      (file) => file.endsWith(".sql"),
    ).length;
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    const db = new DatabaseSync(f.file);
    assert.equal(
      db.prepare("SELECT count(*) n FROM _savia_migrations").get().n,
      migrationCount,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM tenant_slug_aliases WHERE slug='savia-platform' AND tenant_id=0",
        )
        .get().n,
      1,
    );
    assert.ok(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='studio_record_summary_update'",
        )
        .get() ||
        db
          .prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger'")
          .get().n > 60,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("UPDATE tenants SET name='Preserved' WHERE id=0");
    db.close();
    const second = f.run();
    assert.equal(second.status, 0, second.stderr);
    const after = new DatabaseSync(f.file);
    assert.equal(
      after.prepare("SELECT count(*) n FROM _savia_migrations").get().n,
      migrationCount,
    );
    assert.equal(
      after.prepare("SELECT name FROM tenants WHERE id=0").get().name,
      "Preserved",
    );
    after.close();
  } finally {
    f.close();
  }
});

test("a failing schema batch rolls back and can be retried", () => {
  const f = fixture();
  try {
    assert.notEqual(f.run({ FAIL_INITIAL: "1" }).status, 0);
    const db = new DatabaseSync(f.file);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM sqlite_master WHERE name='tenants'")
        .get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM _savia_migrations").get().n,
      0,
    );
    db.close();
    const retry = f.run();
    assert.equal(retry.status, 0, retry.stderr);
  } finally {
    f.close();
  }
});

test("continues when migration history confirms a competing update applied the rejected batch", () => {
  const f = fixture();
  try {
    const result = f.run({ CONCURRENT_D1_BATCH: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Already applied 0001_initial\.sql/);
    assert.match(result.stdout, /Applied 0002_bootstrap\.sql/);
    const db = new DatabaseSync(f.file);
    try {
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS count FROM _savia_migrations WHERE filename = ?",
          )
          .get("0001_initial.sql").count,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

test("retired history is rejected before changing application data", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.file);
    db.exec(
      "CREATE TABLE _savia_migrations(filename TEXT PRIMARY KEY,applied_at TEXT);INSERT INTO _savia_migrations VALUES('retired.sql','now');CREATE TABLE retained(value TEXT);INSERT INTO retained VALUES('keep');",
    );
    db.close();
    const run = f.run();
    assert.notEqual(run.status, 0);
    assert.match(
      run.stderr,
      /D1 migration history contains migrations missing from this checkout/,
    );
    const after = new DatabaseSync(f.file);
    assert.equal(
      after.prepare("SELECT value FROM retained").get().value,
      "keep",
    );
    after.close();
  } finally {
    f.close();
  }
});

test("retries the migration history initialization on D1 queue overload", () => {
  const f = fixture();
  try {
    const result = f.run({ D1_LEDGER_OVERLOAD: "7429" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Applied 0001_initial\.sql/);
  } finally {
    f.close();
  }
});

test("retries an overloaded batch when its migration was still pending", () => {
  const f = fixture();
  try {
    const result = f.run({ D1_BATCH_OVERLOAD_ONCE: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Applied 0001_initial\.sql/);
  } finally {
    f.close();
  }
});

test("checks D1 migration history before replaying a batch after overload", () => {
  const f = fixture();
  try {
    const result = f.run({ D1_OVERLOAD_AFTER_BATCH: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Already applied 0001_initial\.sql/);
    assert.match(result.stdout, /Applied 0002_bootstrap\.sql/);
  } finally {
    f.close();
  }
});

test("fails immediately on an HTTP 429 without the D1 overload code", () => {
  const f = fixture();
  try {
    const result = f.run({ D1_LEDGER_OVERLOAD: "7406" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /D1 query failed \(429\).*7406/);
    assert.doesNotMatch(result.stdout, /Applied /);
  } finally {
    f.close();
  }
});

for (const [retryAfter, requests] of [
  ["", 3],
  ["15", 1],
]) {
  test(`stops D1 overload after ${requests} requests with Retry-After ${retryAfter || "absent"}`, () => {
    const f = fixture();
    try {
      const result = f.run({
        D1_LEDGER_OVERLOAD: "7429",
        D1_PERSISTENT_OVERLOAD: "1",
        D1_RETRY_AFTER: retryAfter,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /D1 query failed \(429\).*7429/);
      assert.equal(
        result.stdout.match(/fixture: ledger request overloaded/g)?.length,
        requests,
      );
    } finally {
      f.close();
    }
  });
}

test("ends a migration when the D1 response body stalls", () => {
  const f = fixture();
  try {
    const result = f.run({ STALL_D1_BODY: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /D1 query timed out.*0001_initial\.sql/);
    assert.doesNotMatch(result.stdout, /Applied /);
  } finally {
    f.close();
  }
});

test("fails when D1 reports an unsuccessful statement in a successful HTTP response", () => {
  const f = fixture();
  try {
    const result = f.run({ REJECT_D1_STATEMENT: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /D1 statement failed.*0001_initial\.sql/);
    assert.doesNotMatch(result.stdout, /Applied /);
  } finally {
    f.close();
  }
});

for (const scenario of ["truncated", "unconfirmed"]) {
  test(`rejects the ${scenario} acknowledgement before reporting a migration as applied`, () => {
    const f = fixture();
    try {
      const result = f.run({ INVALID_D1_ACK: scenario });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /D1 batch result is incomplete.*0001_initial\.sql/,
      );
      assert.doesNotMatch(result.stdout, /Applied /);
    } finally {
      f.close();
    }
  });
}

for (const status of [403, 502, 200]) {
  test(`reports HTTP ${status} when the migration response is not JSON`, () => {
    const f = fixture();
    try {
      const result = f.run({ D1_NON_JSON_STATUS: String(status) });
      assert.equal(result.status, 1);
      assert.ok(
        result.stderr.includes(`D1 query failed (${status})`),
        result.stderr,
      );
      assert.match(result.stderr, /0001_initial\.sql/);
      assert.doesNotMatch(result.stderr, /private upstream response/);
      assert.doesNotMatch(result.stdout, /Applied /);
    } finally {
      f.close();
    }
  });
}
