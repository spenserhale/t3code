/**
 * turnUsage - the pure half of thread usage: what each run used, per model, and what that costs.
 * Nothing is stored: a run is priced when read, with the same rates, custom prices and model
 * mappings as the usage breakdown, so a price saved later reaches every past run too.
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
import { lookupRate, priceUsage } from "./usagePricing.ts";
import { totalTokens } from "@t3tools/provider-core/server/usage";

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
  /** An OpenCode selection's `providerID/modelID`, which a rate table may price apart from `model`. */
  readonly qualifiedModel?: string;
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
 * The id the usage scan records for a model the thread selected: without a `[1m]`-style context
 * suffix, OpenCode's bare `modelID` of its `providerID/modelID`, and other drivers' own alias
 * expansion, as their CLIs receive it.
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

/** Collapses rows that name the same model; two providers' models of one name stay apart. */
function mergeModelRows(rows: readonly ModelUsageRow[]): readonly ModelUsageRow[] {
  const byModel = new Map<string, ModelUsageRow>();
  for (const row of rows) {
    const key = `${row.qualifiedModel ?? ""}\0${row.model}`;
    const previous = byModel.get(key);
    byModel.set(
      key,
      previous ? { ...previous, totals: addTotals(previous.totals, row.totals) } : row,
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
    const driver = providerThread?.driver ?? providerTurn.nativeTurnRef?.driver;
    const row: ModelUsageRow = {
      model: usageModelId(driver, selection.model),
      ...(driver === "opencode" && selection.model.indexOf("/") > 0
        ? { qualifiedModel: selection.model.trim() }
        : {}),
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

/**
 * How long the agent worked on the thread: each finished run from start to finish, overlaps
 * counted once, so the time between turns is left out. A run still going adds nothing yet.
 */
export function threadWorkedMs(records: {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "startedAt" | "completedAt">>;
}): number {
  const spans = records.runs
    .flatMap((run) =>
      run.startedAt === null || run.completedAt === null
        ? []
        : [
            {
              start: DateTime.toEpochMillis(run.startedAt),
              end: DateTime.toEpochMillis(run.completedAt),
            },
          ],
    )
    .filter(({ start, end }) => end > start)
    .toSorted((left, right) => left.start - right.start);
  let total = 0;
  let coveredUntil = Number.NEGATIVE_INFINITY;
  for (const { start, end } of spans) {
    if (end <= coveredUntil) continue;
    total += end - Math.max(start, coveredUntil);
    coveredUntil = end;
  }
  return total;
}

/** Prices a run the way the usage breakdown prices the same tokens. */
export function priceTurn(turn: RecordedTurn, rates: UsageRates): ThreadTurnUsage {
  // A model reports and prices under its provider-qualified id when a mapping, a custom price or
  // a rate knows it, else under the bare id. A mapped model reports and prices as its target, as
  // usage buckets do.
  const known = (id: string) =>
    rates.aliases.has(id) || rates.overrides.has(id.trim()) || lookupRate(rates.table, id) !== null;
  const rows = mergeModelRows(
    turn.models.map(({ model, qualifiedModel, totals }) => {
      const reported =
        qualifiedModel !== undefined && known(qualifiedModel) ? qualifiedModel : model;
      return { model: rates.aliases.get(reported) ?? reported, totals };
    }),
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
