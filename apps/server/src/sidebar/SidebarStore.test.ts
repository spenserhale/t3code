// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SidebarStore from "./SidebarStore.ts";
import { LEGACY_STEPS } from "./sidebarSchema.ts";

const tempFile = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sidebar-store-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
).pipe(Effect.map((dir) => NodePath.join(dir, "nested", "sidebar.sqlite")));

const tables = (database: NodeSqlite.DatabaseSync) =>
  database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row["name"]));

const userVersion = (database: NodeSqlite.DatabaseSync) =>
  Number(database.prepare("PRAGMA user_version").get()?.["user_version"]);

const steps = [
  { name: "first", sql: "CREATE TABLE first_feature (id TEXT PRIMARY KEY) WITHOUT ROWID;" },
  { name: "second", sql: "CREATE TABLE second_feature (id TEXT PRIMARY KEY) WITHOUT ROWID;" },
];

describe("SidebarStore", () => {
  it.effect("opens on first use only, creating the directory and the legacy tables", () =>
    Effect.gen(function* () {
      const filename = yield* tempFile;
      const store = yield* SidebarStore.make(filename);
      assert.isFalse(NodeFS.existsSync(filename));

      const database = yield* store.database;
      assert.isTrue(Option.isSome(database));
      assert.strictEqual(yield* store.database, database);
      const open = Option.getOrThrow(database);
      assert.strictEqual(userVersion(open), LEGACY_STEPS.length);
      assert.includeMembers(tables(open), [
        "sidebar_schema_steps",
        "thread_turn_checked",
        "thread_turn_usage",
        "turn_model_usage",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("serves an in-memory store for tests", () =>
    Effect.gen(function* () {
      const store = yield* SidebarStore.SidebarStore;
      assert.isTrue(Option.isSome(yield* store.database));
    }).pipe(Effect.provide(SidebarStore.layerMemory)),
  );

  it.effect("is None, not a failure, when the file cannot be opened", () =>
    Effect.gen(function* () {
      const filename = yield* tempFile;
      NodeFS.mkdirSync(filename, { recursive: true });
      const store = yield* SidebarStore.make(filename);
      assert.isTrue(Option.isNone(yield* store.database));
    }).pipe(Effect.scoped),
  );

  it.effect("applies each named step once, and later steps on the next open", () =>
    Effect.gen(function* () {
      const filename = yield* tempFile;
      NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
      SidebarStore.openSidebarDatabase(filename, steps.slice(0, 1)).close();
      const reopened = SidebarStore.openSidebarDatabase(filename, steps);
      reopened.close();
      const database = SidebarStore.openSidebarDatabase(filename, steps);
      const applied = database
        .prepare("SELECT name FROM sidebar_schema_steps ORDER BY name")
        .all()
        .map((row) => String(row["name"]));
      assert.deepStrictEqual(applied, ["first", "second"]);
      assert.includeMembers(tables(database), ["first_feature", "second_feature"]);
      database.close();
    }).pipe(Effect.scoped),
  );

  it.effect("rolls a failing step back and records nothing for it", () =>
    Effect.gen(function* () {
      const filename = yield* tempFile;
      NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
      const broken = [{ name: "broken", sql: "CREATE TABLE half (id TEXT); NOT SQL;" }];
      assert.throws(() => SidebarStore.openSidebarDatabase(filename, broken));
      const database = SidebarStore.openSidebarDatabase(filename, []);
      assert.notInclude(tables(database), "half");
      assert.strictEqual(
        database.prepare("SELECT count(*) AS n FROM sidebar_schema_steps").get()?.["n"],
        0,
      );
      database.close();
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a database that already ran the three legacy steps, and its rows", () =>
    Effect.gen(function* () {
      const filename = yield* tempFile;
      NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
      // The shape the 2026-09 store left on disk, before named steps existed.
      const legacy = new NodeSqlite.DatabaseSync(filename);
      LEGACY_STEPS.forEach((step, index) => {
        legacy.exec(`BEGIN; ${step}; PRAGMA user_version = ${index + 1}; COMMIT;`);
      });
      legacy
        .prepare(
          `INSERT INTO turn_model_usage VALUES
            ('thread-1', 'turn-1', 'gpt-5', '2026-10-01T00:00:00.000Z', 1, 2, 3, 4, 5, NULL)`,
        )
        .run();
      legacy.close();

      const database = SidebarStore.openSidebarDatabase(filename, steps);
      assert.strictEqual(userVersion(database), 3);
      assert.strictEqual(
        database.prepare("SELECT count(*) AS n FROM turn_model_usage").get()?.["n"],
        1,
      );
      assert.includeMembers(tables(database), ["first_feature", "second_feature"]);
      database.close();
    }).pipe(Effect.scoped),
  );
});
