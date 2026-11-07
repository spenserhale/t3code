import type { SidebarSchemaStep } from "../sidebar/sidebarSchema.ts";

export const THREAD_WAITS_STEP: SidebarSchemaStep = {
  name: "thread_waits",
  sql: `CREATE TABLE thread_waits (
    thread_id TEXT PRIMARY KEY,
    blocker_thread_id TEXT NOT NULL,
    snoozed_until TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX thread_waits_blocker ON thread_waits (blocker_thread_id);`,
};
