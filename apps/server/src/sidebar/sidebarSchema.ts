/**
 * `sidebar.sqlite` schema. LEGACY_STEPS are positional (`PRAGMA user_version`), shipped, and frozen.
 * SIDEBAR_SCHEMA_STEPS run once each by name, so stacked fork branches can land in any order:
 * a feature defines its step in its own module and appends one entry. Never edit a shipped step.
 */

import { THREAD_WAITS_STEP } from "../threadWaits/threadWaitSchema.ts";

export interface SidebarSchemaStep {
  /** Stable and unique. Never rename a shipped step. */
  readonly name: string;
  readonly sql: string;
}

export const LEGACY_STEPS: readonly string[] = [
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
  `CREATE TABLE thread_turn_checked (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, turn_id)
  ) WITHOUT ROWID;`,
  `CREATE TABLE turn_model_usage (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    model TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    uncached_input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    reported_cost_usd REAL,
    PRIMARY KEY (thread_id, turn_id, model)
  ) WITHOUT ROWID;
  INSERT INTO turn_model_usage
    SELECT thread_id, turn_id,
           CASE WHEN instr(model, '[') > 0 THEN substr(model, 1, instr(model, '[') - 1) ELSE model END,
           completed_at, uncached_input_tokens, cached_input_tokens,
           cache_creation_tokens, output_tokens, reasoning_tokens, NULL
    FROM thread_turn_usage;`,
];

export const SIDEBAR_SCHEMA_STEPS: readonly SidebarSchemaStep[] = [
  // Feature branches append one entry each, defined in the feature's own module.
  THREAD_WAITS_STEP,
];
