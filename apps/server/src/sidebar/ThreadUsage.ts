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
import {
  ThreadId,
  type ThreadUsageTotals,
  type TurnTokenUsage,
  type UsageCostSource,
  type UsageSummaryInput,
  type UsageThreadTotals,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeDayFormatter } from "../usage/usageAggregation.ts";
import { UsageService } from "../usage/UsageService.ts";
import { EMPTY_TOTALS, totalTokens } from "../usage/usageTranscripts.ts";
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

export interface PricedTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly completedAt: string;
  readonly model: string;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
}

export class ThreadUsageService extends Context.Service<
  ThreadUsageService,
  {
    /** Counts a finished turn once; a repeated report for the same turn is ignored. */
    readonly recordTurn: (report: TurnUsageReport) => Effect.Effect<void>;
    readonly getThreadUsage: (threadId: string) => ThreadUsageTotals | null;
    /**
     * Adds turns that were already priced elsewhere (history backfill). Turns the
     * store already holds are left alone. Returns how many were new.
     */
    readonly importTurns: (turns: readonly PricedTurn[]) => number;
    /** Turn ids a backfill can skip: already recorded, or already searched for. */
    readonly settledTurnIds: (threadId: string) => ReadonlySet<string>;
    /** Remembers that these turns were searched for, whatever was found. */
    readonly markTurnsChecked: (threadId: string, turnIds: readonly string[]) => void;
    /** Per-thread totals for a usage window, bounded the way usage buckets are. */
    readonly listThreadUsage: (window: UsageSummaryInput) => readonly UsageThreadTotals[];
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
      return {
        recordTurn: () => Effect.void,
        getThreadUsage: () => null,
        importTurns: () => 0,
        settledTurnIds: () => new Set(),
        markTurnsChecked: () => undefined,
        listThreadUsage: () => [],
      };
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

    // A cold rate table costs a network fetch. Load it now so the first turn
    // to finish is priced from memory instead of holding up its own settle.
    yield* Effect.forkScoped(usageService.priceUsage("", EMPTY_TOTALS, null));

    const insert = database.prepare(
      `INSERT OR IGNORE INTO thread_turn_usage (
         thread_id, turn_id, completed_at, model, uncached_input_tokens, cached_input_tokens,
         cache_creation_tokens, output_tokens, reasoning_tokens, cost_usd, cost_source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const store = (turn: PricedTurn): boolean => {
      const { changes } = insert.run(
        turn.threadId,
        turn.turnId,
        turn.completedAt,
        turn.model,
        turn.totals.uncachedInputTokens,
        turn.totals.cachedInputTokens,
        turn.totals.cacheCreationTokens,
        turn.totals.outputTokens,
        turn.totals.reasoningTokens,
        turn.costUsd,
        turn.costSource,
      );
      if (changes === 0) return false;
      const previous = totalsByThreadId.get(turn.threadId);
      totalsByThreadId.set(turn.threadId, {
        totalTokens: (previous?.totalTokens ?? 0) + totalTokens(turn.totals),
        costUsd: (previous?.costUsd ?? 0) + turn.costUsd,
        turns: (previous?.turns ?? 0) + 1,
        unpricedTurns: (previous?.unpricedTurns ?? 0) + (turn.costSource === "unpriced" ? 1 : 0),
      });
      return true;
    };

    const recordTurn = Effect.fn("ThreadUsageService.recordTurn")(
      function* (report: TurnUsageReport) {
        const totals = turnUsageToTotals(report.usage);
        if (totals === null) return;
        const priced = yield* usageService.priceUsage(report.model, totals, report.reportedCostUsd);
        store({
          threadId: report.threadId,
          turnId: report.turnId,
          completedAt: report.completedAt,
          model: report.model,
          totals,
          costUsd: priced.costUsd,
          costSource: priced.costSource,
        });
      },
      // Usage is an annotation: a full disk or a locked file must not fail the turn.
      Effect.catchCause((cause) => Effect.logWarning("thread usage was not recorded", cause)),
    );

    const selectTurnIds = database.prepare(
      `SELECT turn_id AS turnId FROM thread_turn_usage WHERE thread_id = ?
       UNION SELECT turn_id FROM thread_turn_checked WHERE thread_id = ?`,
    );
    const insertChecked = database.prepare(
      "INSERT OR IGNORE INTO thread_turn_checked (thread_id, turn_id) VALUES (?, ?)",
    );

    const DAY_MS = 24 * 60 * 60 * 1000;
    // A zone is at most 14 hours from UTC, so a day either side covers every
    // turn the day comparison below can admit.
    const selectWindow = database.prepare(
      `SELECT thread_id AS threadId, completed_at AS completedAt, model,
              uncached_input_tokens + cached_input_tokens + cache_creation_tokens + output_tokens AS tokens,
              cost_usd AS costUsd, cost_source AS costSource
       FROM thread_turn_usage WHERE completed_at >= ? AND completed_at < ? ORDER BY completed_at`,
    );

    const listThreadUsage = (window: UsageSummaryInput): readonly UsageThreadTotals[] => {
      const sinceMs = Date.parse(window.sinceTime ?? `${window.sinceDay}T00:00:00Z`);
      const untilMs = Date.parse(window.untilTime ?? `${window.untilDay}T00:00:00Z`);
      if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) return [];
      const hourly = window.sinceTime !== undefined && window.untilTime !== undefined;
      const toDay = makeDayFormatter(window.timeZone);
      const threads = new Map<ThreadId, UsageThreadTotals>();
      const rows = selectWindow.all(
        DateTime.formatIso(DateTime.makeUnsafe(hourly ? sinceMs : sinceMs - DAY_MS)),
        DateTime.formatIso(DateTime.makeUnsafe(hourly ? untilMs : untilMs + 2 * DAY_MS)),
      );
      for (const row of rows) {
        const completedAt = String(row["completedAt"]);
        if (!hourly) {
          const day = toDay(Date.parse(completedAt));
          if (day < window.sinceDay || day > window.untilDay) continue;
        }
        const threadId = ThreadId.make(String(row["threadId"]));
        const model = String(row["model"]);
        const previous = threads.get(threadId);
        threads.set(threadId, {
          threadId,
          totalTokens: (previous?.totalTokens ?? 0) + integer(row["tokens"]),
          costUsd:
            (previous?.costUsd ?? 0) + (typeof row["costUsd"] === "number" ? row["costUsd"] : 0),
          turns: (previous?.turns ?? 0) + 1,
          unpricedTurns:
            (previous?.unpricedTurns ?? 0) + (row["costSource"] === "unpriced" ? 1 : 0),
          lastTurnAt: completedAt,
          models: previous?.models.includes(model)
            ? previous.models
            : [...(previous?.models ?? []), model],
        });
      }
      return [...threads.values()];
    };

    return {
      recordTurn,
      getThreadUsage: (threadId) => totalsByThreadId.get(threadId) ?? null,
      importTurns: (turns) => turns.filter(store).length,
      settledTurnIds: (threadId) =>
        new Set(selectTurnIds.all(threadId, threadId).map((row) => String(row["turnId"]))),
      markTurnsChecked: (threadId, turnIds) => {
        for (const turnId of turnIds) insertChecked.run(threadId, turnId);
      },
      listThreadUsage,
    };
  }),
);
