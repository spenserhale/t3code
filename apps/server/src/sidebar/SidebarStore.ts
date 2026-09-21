// @effect-diagnostics nodeBuiltinImport:off
/**
 * SidebarStore - a second SQLite file, `sidebar.sqlite`, beside `state.sqlite`.
 *
 * It holds data that is additive to the core model and must never change the
 * core schema: `state.sqlite` stays exactly what its migrations produce, so a
 * build without this store can open the same state directory. Rows here point
 * at core data by id only, and the file is disposable: deleting it loses the
 * features' history and nothing else.
 *
 * A store that cannot be opened resolves to `null`. Features degrade; the
 * server still boots.
 *
 * @module SidebarStore
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";

/**
 * Ordered schema steps, tracked with `PRAGMA user_version`. Append only: a
 * shipped step is never edited, because databases that ran it will not rerun it.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE thread_turn_usage (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    model TEXT NOT NULL,
    uncached_input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    cost_source TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  ) WITHOUT ROWID;
  CREATE INDEX thread_turn_usage_completed_at ON thread_turn_usage (completed_at);`,
];

export class SidebarStore extends Context.Service<
  SidebarStore,
  { readonly database: NodeSqlite.DatabaseSync | null }
>()("t3/sidebar/SidebarStore") {}

/** Opens `filename` and brings it up to the current schema. */
export function openSidebarDatabase(filename: string): NodeSqlite.DatabaseSync {
  const database = new NodeSqlite.DatabaseSync(filename);
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    const row = database.prepare("PRAGMA user_version").get();
    const version = typeof row?.["user_version"] === "number" ? row["user_version"] : 0;
    MIGRATIONS.slice(version).forEach((step, index) => {
      database.exec(`BEGIN; ${step}; PRAGMA user_version = ${version + index + 1}; COMMIT;`);
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

const acquire = (filename: string) =>
  Effect.acquireRelease(
    Effect.try(() => openSidebarDatabase(filename)).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("sidebar store unavailable", { filename, error: String(error.cause) }),
      ),
      Effect.orElseSucceed(() => null),
    ),
    (database) => Effect.sync(() => database?.close()),
  );

export const layer = Layer.effect(
  SidebarStore,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const database = yield* Effect.try(() => NodeFS.mkdirSync(stateDir, { recursive: true })).pipe(
      Effect.ignore,
      Effect.andThen(acquire(NodePath.join(stateDir, "sidebar.sqlite"))),
    );
    return { database };
  }),
);

export const layerMemory = Layer.effect(
  SidebarStore,
  acquire(":memory:").pipe(Effect.map((database) => ({ database }))),
);
