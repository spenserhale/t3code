// @effect-diagnostics nodeBuiltinImport:off - a small synchronous sidecar database, outside the core SQL client.
/**
 * `sidebar.sqlite`, beside the core database: fork data that must never touch the core schema.
 * Rows reference core data by id only; deleting the file loses fork data and nothing else.
 * Opened on first use, once. An unopenable store is `None`: features degrade, the server boots.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { LEGACY_STEPS, SIDEBAR_SCHEMA_STEPS, type SidebarSchemaStep } from "./sidebarSchema.ts";

export class SidebarStore extends Context.Service<
  SidebarStore,
  { readonly database: Effect.Effect<Option.Option<NodeSqlite.DatabaseSync>> }
>()("t3/sidebar/SidebarStore") {}

const userVersion = (database: NodeSqlite.DatabaseSync) => {
  const row = database.prepare("PRAGMA user_version").get();
  return typeof row?.["user_version"] === "number" ? row["user_version"] : 0;
};

/** Opens `filename` and brings it up to `steps`, the current schema unless a test passes its own. */
export function openSidebarDatabase(
  filename: string,
  steps: readonly SidebarSchemaStep[] = SIDEBAR_SCHEMA_STEPS,
): NodeSqlite.DatabaseSync {
  const database = new NodeSqlite.DatabaseSync(filename);
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    const version = userVersion(database);
    LEGACY_STEPS.slice(version).forEach((step, index) => {
      database.exec(`BEGIN; ${step}; PRAGMA user_version = ${version + index + 1}; COMMIT;`);
    });
    database.exec(
      `CREATE TABLE IF NOT EXISTS sidebar_schema_steps (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) WITHOUT ROWID;`,
    );
    const applied = new Set(
      database
        .prepare("SELECT name FROM sidebar_schema_steps")
        .all()
        .map((row) => String(row["name"])),
    );
    const record = database.prepare(
      "INSERT INTO sidebar_schema_steps (name, applied_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    );
    for (const step of steps) {
      if (applied.has(step.name)) continue;
      database.exec("BEGIN");
      try {
        database.exec(step.sql);
        record.run(step.name);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    return database;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
    throw error;
  }
}

/** A store over `filename`, opened when a feature first asks for it. */
export const make = Effect.fn("SidebarStore.make")(function* (filename: string) {
  let opened: Option.Option<NodeSqlite.DatabaseSync> | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (opened !== undefined && Option.isSome(opened)) opened.value.close();
    }),
  );
  // Opening is synchronous, so two first callers cannot both open the file.
  const database = Effect.suspend(() =>
    opened !== undefined
      ? Effect.succeed(opened)
      : Effect.try(() => {
          if (filename !== ":memory:") {
            NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
          }
          return openSidebarDatabase(filename);
        }).pipe(
          Effect.asSome,
          Effect.tapError((error) =>
            Effect.logWarning("sidebar store unavailable", {
              filename,
              error: String(error.cause),
            }),
          ),
          Effect.orElseSucceed(() => Option.none<NodeSqlite.DatabaseSync>()),
          Effect.tap((result) =>
            Effect.sync(() => {
              opened = result;
            }),
          ),
        ),
  );
  return SidebarStore.of({ database });
});

export const layer = Layer.effect(
  SidebarStore,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    return yield* make(NodePath.join(stateDir, "sidebar.sqlite"));
  }),
);

export const layerMemory = Layer.effect(SidebarStore, make(":memory:"));
