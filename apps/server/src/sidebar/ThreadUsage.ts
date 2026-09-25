/**
 * ThreadUsageService - tokens and estimated cost per thread and per turn.
 *
 * Ingestion hands each finished turn here. Its tokens are stored per model in
 * the sidebar store, never its price: turns are priced when read, with the
 * same rate table and custom prices as the usage breakdown, so a custom price
 * or a rate refresh reaches every past turn too. Everything is also held in
 * memory, so the shell query can read a thread's totals synchronously at
 * mapping time, the way it reads plan progress.
 *
 * Only turns driven through T3 Code are counted. Providers that report no turn
 * usage never appear.
 *
 * @module ThreadUsageService
 */
import {
  ThreadId,
  type ProviderDriverKind,
  type ThreadUsageDetail,
  type ThreadUsageTotals,
  type TurnTokenUsage,
  type UsageSummaryInput,
  type UsageThreadTotals,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { makeDayFormatter } from "../usage/usageAggregation.ts";
import { UsageService, type UsageRates } from "../usage/UsageService.ts";
import { SidebarStore } from "./SidebarStore.ts";
import {
  EMPTY_RATES,
  claudeTurnRows,
  mergeModelRows,
  priceTurn,
  readClaudeSessionTotals,
  sumTurns,
  turnUsageToTotals,
  usageModelId,
  type ClaudeSessionTotals,
  type ModelUsageRow,
  type RecordedTurn,
} from "./turnUsage.ts";

export interface TurnUsageReport {
  readonly threadId: string;
  readonly turnId: string;
  readonly completedAt: string;
  readonly driver: ProviderDriverKind;
  /** The thread's selected model, as the picker names it. */
  readonly model: string;
  readonly usage: TurnTokenUsage;
  /** Claude's running per-model session totals, when the provider sends them. */
  readonly modelUsage?: unknown;
}

export class ThreadUsageService extends Context.Service<
  ThreadUsageService,
  {
    /** Counts a finished turn once; a repeated report for the same turn is ignored. */
    readonly recordTurn: (report: TurnUsageReport) => Effect.Effect<void>;
    /** The thread's provider session ended or began, so running totals start over. */
    readonly forgetSession: (threadId: string) => void;
    /** Totals at the last rates seen. Synchronous, for the shell query. */
    readonly getThreadUsage: (threadId: string) => ThreadUsageTotals | null;
    /** Every recorded turn of a thread, priced at the current rates. */
    readonly readThreadUsage: (threadId: ThreadId) => Effect.Effect<ThreadUsageDetail>;
    /** Per-thread totals for a usage window, bounded the way usage buckets are. */
    readonly listThreadUsage: (
      window: UsageSummaryInput,
    ) => Effect.Effect<readonly UsageThreadTotals[]>;
    /**
     * Adds turns rebuilt elsewhere (history backfill). Turns the store already
     * holds are left alone. Returns how many were new.
     */
    readonly importTurns: (turns: readonly RecordedTurn[]) => number;
    /** Turn ids a backfill can skip: already recorded, or already searched for. */
    readonly settledTurnIds: (threadId: string) => ReadonlySet<string>;
    /** Remembers that these turns were searched for, whatever was found. */
    readonly markTurnsChecked: (threadId: string, turnIds: readonly string[]) => void;
  }
>()("t3/sidebar/ThreadUsage/ThreadUsageService") {}

const integer = (value: unknown) => (typeof value === "number" ? Math.trunc(value) : 0);

export const layer = Layer.effect(
  ThreadUsageService,
  Effect.gen(function* () {
    const { database } = yield* SidebarStore;
    const usageService = yield* UsageService;
    const settings = yield* Effect.serviceOption(ServerSettingsService);

    if (database === null) {
      return {
        recordTurn: () => Effect.void,
        forgetSession: () => undefined,
        getThreadUsage: () => null,
        readThreadUsage: (threadId) => Effect.succeed({ threadId, turns: [] }),
        listThreadUsage: () => Effect.succeed([]),
        importTurns: () => 0,
        settledTurnIds: () => new Set(),
        markTurnsChecked: () => undefined,
      };
    }

    const turnsByThread = new Map<string, Map<string, RecordedTurn>>();
    const remember = (turn: RecordedTurn) => {
      const turns = turnsByThread.get(turn.threadId) ?? new Map<string, RecordedTurn>();
      turns.set(turn.turnId, turn);
      turnsByThread.set(turn.threadId, turns);
    };

    const loaded = new Map<string, RecordedTurn & { models: ModelUsageRow[] }>();
    for (const row of database
      .prepare(`SELECT * FROM turn_model_usage ORDER BY completed_at, thread_id, turn_id`)
      .all()) {
      const key = `${String(row["thread_id"])}\u0000${String(row["turn_id"])}`;
      const turn = loaded.get(key) ?? {
        threadId: String(row["thread_id"]),
        turnId: String(row["turn_id"]),
        completedAt: String(row["completed_at"]),
        models: [],
      };
      turn.models.push({
        model: String(row["model"]),
        totals: {
          uncachedInputTokens: integer(row["uncached_input_tokens"]),
          cachedInputTokens: integer(row["cached_input_tokens"]),
          cacheCreationTokens: integer(row["cache_creation_tokens"]),
          outputTokens: integer(row["output_tokens"]),
          reasoningTokens: integer(row["reasoning_tokens"]),
        },
        reportedCostUsd:
          typeof row["reported_cost_usd"] === "number" ? row["reported_cost_usd"] : null,
      });
      loaded.set(key, turn);
    }
    loaded.forEach(remember);

    // Totals are cached per thread and dropped whenever the rates change.
    let rates: UsageRates = EMPTY_RATES;
    const totalsByThread = new Map<string, ThreadUsageTotals>();
    const syncRates = usageService.currentRates.pipe(
      Effect.tap((next) =>
        Effect.sync(() => {
          if (next.version === rates.version) return;
          rates = next;
          totalsByThread.clear();
        }),
      ),
    );
    // Shells built before the rates arrive would go out unpriced, so wait
    // briefly for them: from disk this is instant. A cold table costs a network
    // fetch, which finishes in the background instead of holding up the server.
    yield* syncRates.pipe(Effect.timeout("2 seconds"), Effect.ignore);
    if (rates === EMPTY_RATES) yield* Effect.forkScoped(syncRates);
    // Custom prices apply as soon as they are saved.
    if (settings._tag === "Some") {
      yield* Stream.runForEach(settings.value.streamChanges, () => syncRates).pipe(
        Effect.forkScoped,
      );
    }

    const getThreadUsage = (threadId: string): ThreadUsageTotals | null => {
      const cached = totalsByThread.get(threadId);
      if (cached) return cached;
      const turns = turnsByThread.get(threadId);
      if (turns === undefined || turns.size === 0) return null;
      const totals = sumTurns([...turns.values()].map((turn) => priceTurn(turn, rates)));
      if (rates !== EMPTY_RATES) totalsByThread.set(threadId, totals);
      return totals;
    };

    const insert = database.prepare(
      `INSERT OR IGNORE INTO turn_model_usage (
         thread_id, turn_id, model, completed_at, uncached_input_tokens, cached_input_tokens,
         cache_creation_tokens, output_tokens, reasoning_tokens, reported_cost_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const store = (turn: RecordedTurn): boolean => {
      if (turn.models.length === 0 || turnsByThread.get(turn.threadId)?.has(turn.turnId)) {
        return false;
      }
      database.exec("BEGIN");
      try {
        for (const row of turn.models) {
          insert.run(
            turn.threadId,
            turn.turnId,
            row.model,
            turn.completedAt,
            row.totals.uncachedInputTokens,
            row.totals.cachedInputTokens,
            row.totals.cacheCreationTokens,
            row.totals.outputTokens,
            row.totals.reasoningTokens,
            row.reportedCostUsd,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      remember(turn);
      totalsByThread.delete(turn.threadId);
      return true;
    };

    // Claude reports running totals for its session; each turn is the difference.
    // They live as long as the provider session, which never outlives the server.
    // A turn that is not recorded (interrupted without a result) is carried into
    // the next recorded turn rather than lost.
    const claudeSessions = new Map<string, ClaudeSessionTotals>();

    const recordTurn = Effect.fn("ThreadUsageService.recordTurn")(
      function* (report: TurnUsageReport) {
        const session =
          report.driver === "claudeAgent" ? readClaudeSessionTotals(report.modelUsage) : null;
        let models: readonly ModelUsageRow[] = [];
        if (session !== null) {
          models = claudeTurnRows(session, claudeSessions.get(report.threadId));
          claudeSessions.set(report.threadId, session);
        }
        if (models.length === 0) {
          const totals = turnUsageToTotals(report.usage);
          if (totals === null) return;
          models = [
            {
              model: usageModelId(report.driver, report.model),
              totals,
              reportedCostUsd: null,
            },
          ];
        }
        store({
          threadId: report.threadId,
          turnId: report.turnId,
          completedAt: report.completedAt,
          models: mergeModelRows(models),
        });
      },
      // Usage is an annotation: a full disk or a locked file must not fail the turn.
      Effect.catchCause((cause) => Effect.logWarning("thread usage was not recorded", cause)),
    );

    const readThreadUsage = (threadId: ThreadId) =>
      syncRates.pipe(
        Effect.map((current): ThreadUsageDetail => ({
          threadId,
          turns: [...(turnsByThread.get(threadId)?.values() ?? [])]
            .map((turn) => priceTurn(turn, current))
            .toSorted((left, right) => left.completedAt.localeCompare(right.completedAt)),
        })),
      );

    const DAY_MS = 24 * 60 * 60 * 1000;

    const listThreadUsage = (window: UsageSummaryInput) =>
      syncRates.pipe(
        Effect.map((current): readonly UsageThreadTotals[] => {
          const sinceMs = Date.parse(window.sinceTime ?? `${window.sinceDay}T00:00:00Z`);
          const untilMs = Date.parse(window.untilTime ?? `${window.untilDay}T00:00:00Z`);
          if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) return [];
          const hourly = window.sinceTime !== undefined && window.untilTime !== undefined;
          const toDay = makeDayFormatter(window.timeZone);
          // A zone is at most 14 hours from UTC, so a day either side covers every
          // turn the day comparison below can admit.
          const lowerMs = hourly ? sinceMs : sinceMs - DAY_MS;
          const upperMs = hourly ? untilMs : untilMs + 2 * DAY_MS;
          const threads: UsageThreadTotals[] = [];
          for (const [threadId, turns] of turnsByThread) {
            const inWindow = [...turns.values()].filter((turn) => {
              const completedMs = Date.parse(turn.completedAt);
              if (!(completedMs >= lowerMs && completedMs < upperMs)) return false;
              if (hourly) return true;
              const day = toDay(completedMs);
              return day >= window.sinceDay && day <= window.untilDay;
            });
            if (inWindow.length === 0) continue;
            const priced = inWindow.map((turn) => priceTurn(turn, current));
            threads.push({
              threadId: ThreadId.make(threadId),
              ...sumTurns(priced),
              lastTurnAt: inWindow.reduce(
                (latest, turn) => (turn.completedAt > latest ? turn.completedAt : latest),
                "",
              ),
              models: [...new Set(inWindow.flatMap((turn) => turn.models.map((row) => row.model)))],
            });
          }
          return threads;
        }),
      );

    const selectChecked = database.prepare(
      "SELECT turn_id AS turnId FROM thread_turn_checked WHERE thread_id = ?",
    );
    const insertChecked = database.prepare(
      "INSERT OR IGNORE INTO thread_turn_checked (thread_id, turn_id) VALUES (?, ?)",
    );

    return {
      recordTurn,
      forgetSession: (threadId) => {
        claudeSessions.delete(threadId);
      },
      getThreadUsage,
      readThreadUsage,
      listThreadUsage,
      importTurns: (turns) => turns.filter(store).length,
      settledTurnIds: (threadId) =>
        new Set([
          ...(turnsByThread.get(threadId)?.keys() ?? []),
          ...selectChecked.all(threadId).map((row) => String(row["turnId"])),
        ]),
      markTurnsChecked: (threadId, turnIds) => {
        for (const turnId of turnIds) insertChecked.run(threadId, turnId);
      },
    };
  }),
);
