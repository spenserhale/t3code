import * as Schema from "effect/Schema";

import { NonNegativeInt, RunId, ThreadId } from "./baseSchemas.ts";
import { UsageCostSource } from "./usage.ts";

/**
 * One thread's usage inside a window, from the turns this server drove.
 * Unlike buckets it is not read from provider transcripts, so it excludes work
 * done outside SECode and does not sum to the bucket totals.
 */
export const UsageThreadTotals = Schema.Struct({
  threadId: ThreadId,
  totalTokens: NonNegativeInt,
  costUsd: Schema.Finite,
  turns: NonNegativeInt,
  /** Turns counted in `totalTokens` that added nothing to `costUsd`. */
  unpricedTurns: NonNegativeInt,
  lastTurnAt: Schema.String,
  models: Schema.Array(Schema.String),
});
export type UsageThreadTotals = typeof UsageThreadTotals.Type;

/** Every thread with a turn finished inside the window a usage summary would take. */
export const ThreadUsageList = Schema.Struct({ threads: Schema.Array(UsageThreadTotals) });
export type ThreadUsageList = typeof ThreadUsageList.Type;

export const ThreadUsageInput = Schema.Struct({ threadId: ThreadId });
export type ThreadUsageInput = typeof ThreadUsageInput.Type;

/**
 * One model's share of a turn. `model` is the model the run selected, named the
 * way the usage breakdown names it wherever the two differ by rule. A custom
 * price or model mapping for that id applies; `customPrice` says a price did.
 */
export const ThreadUsageModel = Schema.Struct({
  model: Schema.String,
  totalTokens: NonNegativeInt,
  costUsd: Schema.Finite,
  costSource: UsageCostSource,
  customPrice: Schema.Boolean,
});
export type ThreadUsageModel = typeof ThreadUsageModel.Type;

/**
 * What one run used, from the provider turns orchestration recorded for it.
 * Priced when read, so later price changes apply to it. Figures cover the main
 * agent; `hasSubagents` says subagents also ran, whose tokens are not included.
 */
export const ThreadTurnUsage = Schema.Struct({
  /** `null` for a provider turn outside any run, such as a subagent thread's own. */
  runId: Schema.NullOr(RunId),
  completedAt: Schema.String,
  totalTokens: NonNegativeInt,
  costUsd: Schema.Finite,
  hasSubagents: Schema.Boolean,
  models: Schema.Array(ThreadUsageModel),
});
export type ThreadTurnUsage = typeof ThreadTurnUsage.Type;

export const ThreadUsageDetail = Schema.Struct({
  threadId: ThreadId,
  /** Oldest first. Turns with no reported usage are absent. */
  turns: Schema.Array(ThreadTurnUsage),
});
export type ThreadUsageDetail = typeof ThreadUsageDetail.Type;
