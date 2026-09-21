/**
 * ThreadUsageService - tokens and estimated cost per thread.
 *
 * Providers report main-agent usage when a turn ends. Ingestion hands each
 * report here; it is priced once, at the rates in effect when the turn ended,
 * and stored in the sidebar store. Per-thread totals are kept in memory so the
 * shell query can read them synchronously at mapping time, the same way it
 * reads plan progress.
 *
 * Only turns driven through T3 Code after this service existed are counted.
 * Providers that report no turn usage never appear.
 *
 * @module ThreadUsageService
 */
import type { ThreadUsageTotals, TurnTokenUsage, UsageTokenTotals } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { UsageService } from "../usage/UsageService.ts";
import { totalTokens } from "../usage/usageTranscripts.ts";
import { SidebarStore } from "./SidebarStore.ts";

export interface TurnUsageReport {
  readonly threadId: string;
  readonly turnId: string;
  readonly completedAt: string;
  readonly model: string;
  readonly usage: TurnTokenUsage;
  /** The provider's own figure for the turn, when it gives one. */
  readonly reportedCostUsd: number | null;
}

export class ThreadUsageService extends Context.Service<
  ThreadUsageService,
  {
    /** Counts a finished turn once; a repeated report for the same turn is ignored. */
    readonly recordTurn: (report: TurnUsageReport) => Effect.Effect<void>;
    readonly getThreadUsage: (threadId: string) => ThreadUsageTotals | null;
  }
>()("t3/sidebar/ThreadUsage/ThreadUsageService") {}

/**
 * Turn usage counts cache reads and writes inside `inputTokens`; usage totals
 * keep them apart, because each is priced at its own rate.
 */
export function turnUsageToTotals(usage: TurnTokenUsage): UsageTokenTotals | null {
  if (usage.usageStatus === "unavailable") return null;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totals = {
    uncachedInputTokens: Math.max(
      0,
      (usage.inputTokens ?? 0) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, usage.reasoningTokens ?? 0),
  };
  return totalTokens(totals) === 0 ? null : totals;
}

const integer = (value: unknown) => (typeof value === "number" ? Math.trunc(value) : 0);

export const layer = Layer.effect(
  ThreadUsageService,
  Effect.gen(function* () {
    const { database } = yield* SidebarStore;
    const usageService = yield* UsageService;
    const totalsByThreadId = new Map<string, ThreadUsageTotals>();

    if (database === null) {
      return { recordTurn: () => Effect.void, getThreadUsage: () => null };
    }

    const rows = database
      .prepare(
        `SELECT thread_id AS threadId,
                SUM(uncached_input_tokens + cached_input_tokens + cache_creation_tokens + output_tokens) AS totalTokens,
                SUM(cost_usd) AS costUsd,
                COUNT(*) AS turns,
                SUM(cost_source = 'unpriced') AS unpricedTurns
         FROM thread_turn_usage GROUP BY thread_id`,
      )
      .all();
    for (const row of rows) {
      totalsByThreadId.set(String(row["threadId"]), {
        totalTokens: integer(row["totalTokens"]),
        costUsd: typeof row["costUsd"] === "number" ? row["costUsd"] : 0,
        turns: integer(row["turns"]),
        unpricedTurns: integer(row["unpricedTurns"]),
      });
    }

    const insert = database.prepare(
      `INSERT OR IGNORE INTO thread_turn_usage (
         thread_id, turn_id, completed_at, model, uncached_input_tokens, cached_input_tokens,
         cache_creation_tokens, output_tokens, reasoning_tokens, cost_usd, cost_source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const recordTurn = Effect.fn("ThreadUsageService.recordTurn")(
      function* (report: TurnUsageReport) {
        const totals = turnUsageToTotals(report.usage);
        if (totals === null) return;
        const priced = yield* usageService.priceUsage(report.model, totals, report.reportedCostUsd);
        const { changes } = insert.run(
          report.threadId,
          report.turnId,
          report.completedAt,
          report.model,
          totals.uncachedInputTokens,
          totals.cachedInputTokens,
          totals.cacheCreationTokens,
          totals.outputTokens,
          totals.reasoningTokens,
          priced.costUsd,
          priced.costSource,
        );
        if (changes === 0) return;
        const previous = totalsByThreadId.get(report.threadId);
        totalsByThreadId.set(report.threadId, {
          totalTokens: (previous?.totalTokens ?? 0) + totalTokens(totals),
          costUsd: (previous?.costUsd ?? 0) + priced.costUsd,
          turns: (previous?.turns ?? 0) + 1,
          unpricedTurns:
            (previous?.unpricedTurns ?? 0) + (priced.costSource === "unpriced" ? 1 : 0),
        });
      },
      // Usage is an annotation: a full disk or a locked file must not fail the turn.
      Effect.catchCause((cause) => Effect.logWarning("thread usage was not recorded", cause)),
    );

    return {
      recordTurn,
      getThreadUsage: (threadId) => totalsByThreadId.get(threadId) ?? null,
    };
  }),
);
