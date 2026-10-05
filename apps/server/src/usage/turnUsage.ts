/**
 * turnUsage - the pure half of thread usage: what each run of a thread used,
 * per model, and what that costs at a given set of rates.
 *
 * Nothing is stored for this. Orchestration already records the main agent's
 * tokens on every provider turn (`turnTokenUsage`), and a run is priced when
 * read, with the same rate table, custom prices and model mappings as the
 * usage breakdown. A price saved later therefore reaches every past run too.
 *
 * @module turnUsage
 */
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ProviderDriverKind,
  RunId,
  ThreadId,
  ThreadTurnUsage,
  ThreadUsageModel,
  TurnTokenUsage,
  UsageSummaryInput,
  UsageThreadTotals,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

import type { UsageRates } from "./UsageService.ts";
import { makeDayFormatter } from "./usageAggregation.ts";
import { priceUsage } from "./usagePricing.ts";
import { totalTokens } from "./usageTranscripts.ts";

/** The parts of a thread's projection that decide its usage. */
export interface ThreadUsageRecords {
  readonly thread: Pick<OrchestrationV2AppThread, "modelSelection">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "modelSelection">>;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderTurn,
      | "id"
      | "providerThreadId"
      | "runAttemptId"
      | "nativeTurnRef"
      | "completedAt"
      | "turnTokenUsage"
    >
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "driver" | "nativeMetadata">
  >;
}

/** One model's share of a run, before pricing. */
export interface ModelUsageRow {
  readonly model: string;
  readonly totals: UsageTokenTotals;
}

/** A run's tokens. Several provider turns of one run (a steer, a retry) add up. */
export interface RecordedTurn {
  /** `null` for a provider turn outside any run, such as a subagent thread's own. */
  readonly runId: RunId | null;
  /** When the last of its provider turns finished. */
  readonly completedAtMs: number;
  readonly hasSubagents: boolean;
  readonly models: readonly ModelUsageRow[];
}

/**
 * The id the usage scan records for a model the thread selected.
 *
 * - A `[1m]`-style suffix selects a context window, not a model; transcripts
 *   never carry it.
 * - OpenCode selections are `providerID/modelID`, and its database records
 *   the bare `modelID`.
 * - Other drivers get their own alias expansion, as their CLIs receive it.
 */
export function usageModelId(driver: ProviderDriverKind | undefined, model: string): string {
  const trimmed = model.trim().replace(/\[.*$/, "");
  if (driver === "opencode") {
    const slash = trimmed.indexOf("/");
    return slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  }
  return normalizeModelSlug(trimmed, driver) ?? trimmed;
}

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

function addTotals(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

/** Collapses rows that name the same model. */
function mergeModelRows(rows: readonly ModelUsageRow[]): readonly ModelUsageRow[] {
  const byModel = new Map<string, ModelUsageRow>();
  for (const row of rows) {
    const previous = byModel.get(row.model);
    byModel.set(
      row.model,
      previous ? { model: row.model, totals: addTotals(previous.totals, row.totals) } : row,
    );
  }
  return [...byModel.values()];
}

/**
 * Groups a thread's finished provider turns by run, oldest first. A turn
 * counts under the model its run selected. A turn with no run counts on its
 * own, under the model its provider thread reports, else the thread's.
 * Turns that reported no usage produce nothing.
 */
export function recordedTurns(records: ThreadUsageRecords): readonly RecordedTurn[] {
  const runIdByAttemptId = new Map(records.attempts.map((attempt) => [attempt.id, attempt.runId]));
  const runById = new Map(records.runs.map((run) => [run.id, run]));
  const providerThreadById = new Map(records.providerThreads.map((thread) => [thread.id, thread]));

  const turnsByKey = new Map<string, RecordedTurn>();
  for (const providerTurn of records.providerTurns) {
    if (providerTurn.completedAt === null || providerTurn.turnTokenUsage === undefined) continue;
    const totals = turnUsageToTotals(providerTurn.turnTokenUsage);
    if (totals === null) continue;

    const runId =
      providerTurn.runAttemptId === null
        ? null
        : (runIdByAttemptId.get(providerTurn.runAttemptId) ?? null);
    const providerThread = providerThreadById.get(providerTurn.providerThreadId);
    const selection =
      (runId === null ? undefined : runById.get(runId)?.modelSelection) ??
      providerThread?.nativeMetadata?.modelSelection ??
      records.thread.modelSelection;
    const row: ModelUsageRow = {
      model: usageModelId(
        providerThread?.driver ?? providerTurn.nativeTurnRef?.driver,
        selection.model,
      ),
      totals,
    };
    const completedAtMs = DateTime.toEpochMillis(providerTurn.completedAt);

    const key = runId ?? providerTurn.id;
    const previous = turnsByKey.get(key);
    turnsByKey.set(key, {
      runId,
      completedAtMs: Math.max(previous?.completedAtMs ?? 0, completedAtMs),
      hasSubagents: (previous?.hasSubagents ?? false) || providerTurn.turnTokenUsage.hasSubagents,
      models: mergeModelRows([...(previous?.models ?? []), row]),
    });
  }
  return [...turnsByKey.values()].toSorted(
    (left, right) => left.completedAtMs - right.completedAtMs,
  );
}

/** Prices a run the way the usage breakdown prices the same tokens. */
export function priceTurn(turn: RecordedTurn, rates: UsageRates): ThreadTurnUsage {
  // A mapped model reports and prices as its target, as usage buckets do.
  const rows = mergeModelRows(
    turn.models.map((row) => ({ ...row, model: rates.aliases.get(row.model) ?? row.model })),
  );
  const models = rows.map((row): ThreadUsageModel => {
    const priced = priceUsage(
      rates.table,
      // Orchestration records neither a provider's own cost nor the speed a
      // turn billed at, so every turn is estimated at the standard rate.
      { model: row.model, totals: row.totals, speed: "standard", reportedCostUsd: null },
      rates.overrides,
    );
    return {
      model: row.model,
      totalTokens: totalTokens(row.totals),
      costUsd: priced.costUsd,
      costSource: priced.costSource,
      customPrice: rates.overrides.has(row.model.trim()),
    };
  });
  return {
    runId: turn.runId,
    completedAt: DateTime.formatIso(DateTime.makeUnsafe(turn.completedAtMs)),
    totalTokens: models.reduce((sum, model) => sum + model.totalTokens, 0),
    costUsd: models.reduce((sum, model) => sum + model.costUsd, 0),
    hasSubagents: turn.hasSubagents,
    models,
  };
}

/** True when no model in the turn had a price, so its cost is unknown rather than zero. */
function isTurnUnpriced(turn: ThreadTurnUsage): boolean {
  return turn.models.every((model) => model.costSource === "unpriced");
}

/** Totals of a thread's priced turns for a usage window, or `null` for none. */
export function threadTotals(
  threadId: ThreadId,
  turns: readonly ThreadTurnUsage[],
): UsageThreadTotals | null {
  if (turns.length === 0) return null;
  return {
    threadId,
    totalTokens: turns.reduce((sum, turn) => sum + turn.totalTokens, 0),
    costUsd: turns.reduce((sum, turn) => sum + turn.costUsd, 0),
    turns: turns.length,
    unpricedTurns: turns.filter(isTurnUnpriced).length,
    lastTurnAt: turns.reduce(
      (latest, turn) => (turn.completedAt > latest ? turn.completedAt : latest),
      "",
    ),
    models: [...new Set(turns.flatMap((turn) => turn.models.map((model) => model.model)))],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageWindow {
  /** Bounds no turn in the window can fall outside, for a cheap first cut. */
  readonly lowerMs: number;
  readonly upperMs: number;
  readonly contains: (completedAtMs: number) => boolean;
}

/**
 * The turns a usage window admits, bounded the way usage buckets are: by
 * instant for an hourly window, else by day in the window's zone. `null` for a
 * window that cannot be read.
 */
export function usageWindow(input: UsageSummaryInput): UsageWindow | null {
  if (input.resolution === "hour") {
    const sinceMs = Date.parse(input.sinceTime ?? "");
    const untilMs = Date.parse(input.untilTime ?? "");
    if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) return null;
    return {
      lowerMs: sinceMs,
      upperMs: untilMs,
      contains: (completedAtMs) => completedAtMs >= sinceMs && completedAtMs < untilMs,
    };
  }
  const sinceMs = Date.parse(`${input.sinceDay}T00:00:00Z`);
  const untilMs = Date.parse(`${input.untilDay}T00:00:00Z`);
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) return null;
  const toDay = makeDayFormatter(input.timeZone);
  return {
    // A zone is at most 14 hours from UTC, so a day either side covers every
    // turn the day comparison can admit.
    lowerMs: sinceMs - DAY_MS,
    upperMs: untilMs + 2 * DAY_MS,
    contains: (completedAtMs) => {
      const day = toDay(completedAtMs);
      return day >= input.sinceDay && day <= input.untilDay;
    },
  };
}
