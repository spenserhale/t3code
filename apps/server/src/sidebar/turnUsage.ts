/**
 * turnUsage - the pure half of thread usage: what a finished turn used, per
 * model, and what that costs at a given set of rates.
 *
 * Model ids are stored the way the usage breakdown shows them, which is also
 * how custom prices are keyed. A custom price entered for a model on the Usage
 * page therefore prices that model's turns too, past ones included, because
 * turns are priced when read rather than when recorded.
 *
 * @module turnUsage
 */
import type {
  ProviderDriverKind,
  ThreadTurnUsage,
  ThreadUsageModel,
  ThreadUsageTotals,
  TurnId,
  TurnTokenUsage,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import type { UsageRates } from "../usage/UsageService.ts";
import { priceUsage } from "../usage/usagePricing.ts";
import { addTotals, totalTokens } from "../usage/usageTranscripts.ts";

/** One model's share of a turn, before pricing. */
export interface ModelUsageRow {
  readonly model: string;
  readonly totals: UsageTokenTotals;
  /** The provider's own figure for these tokens, when it gives one. */
  readonly reportedCostUsd: number | null;
}

export interface RecordedTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly completedAt: string;
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
export function usageModelId(driver: string, model: string): string {
  const trimmed = model.trim().replace(/\[.*$/, "");
  if (driver === "opencode") {
    const slash = trimmed.indexOf("/");
    return slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  }
  return normalizeModelSlug(trimmed, driver as ProviderDriverKind) ?? trimmed;
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

/** Running per-model totals of one Claude session, keyed by usage model id. */
export type ClaudeSessionTotals = ReadonlyMap<
  string,
  { readonly totals: UsageTokenTotals; readonly costUsd: number | null }
>;

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

/**
 * Reads the Claude SDK's `modelUsage`: exact model ids, subagents and
 * compaction included, as running totals for the whole session.
 */
export function readClaudeSessionTotals(modelUsage: unknown): ClaudeSessionTotals | null {
  if (typeof modelUsage !== "object" || modelUsage === null) return null;
  const byModel = new Map<string, { totals: UsageTokenTotals; costUsd: number | null }>();
  for (const [rawModel, value] of Object.entries(modelUsage)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const outputTokens = count(entry["outputTokens"]);
    const totals: UsageTokenTotals = {
      uncachedInputTokens: count(entry["inputTokens"]),
      cachedInputTokens: count(entry["cacheReadInputTokens"]),
      cacheCreationTokens: count(entry["cacheCreationInputTokens"]),
      outputTokens,
      reasoningTokens: Math.min(outputTokens, count(entry["thinkingTokens"])),
    };
    const cost = entry["costUSD"];
    const model = usageModelId("claudeAgent", rawModel);
    const previous = byModel.get(model);
    const costUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : null;
    byModel.set(model, {
      totals: previous ? addTotals(previous.totals, totals) : totals,
      costUsd: previous ? sumNullable(previous.costUsd, costUsd) : costUsd,
    });
  }
  return byModel.size === 0 ? null : byModel;
}

const sumNullable = (left: number | null, right: number | null) =>
  left === null || right === null ? null : left + right;

const TOKEN_FIELDS = [
  "uncachedInputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "outputTokens",
  "reasoningTokens",
] as const;

/**
 * What one turn added to a Claude session's running totals. A total that went
 * down means the session started over (a restart or `/clear`), so the current
 * figures are the turn's own.
 */
export function claudeTurnRows(
  current: ClaudeSessionTotals,
  previous: ClaudeSessionTotals | undefined,
): readonly ModelUsageRow[] {
  const restarted =
    previous === undefined ||
    [...previous].some(([model, before]) => {
      const after = current.get(model);
      return (
        after === undefined ||
        TOKEN_FIELDS.some((field) => after.totals[field] < before.totals[field])
      );
    });
  const rows: ModelUsageRow[] = [];
  for (const [model, after] of current) {
    const before = restarted ? undefined : previous?.get(model);
    const totals = Object.fromEntries(
      TOKEN_FIELDS.map((field) => [field, after.totals[field] - (before?.totals[field] ?? 0)]),
    ) as unknown as UsageTokenTotals;
    if (totalTokens(totals) === 0) continue;
    const costUsd =
      after.costUsd === null
        ? null
        : before === undefined
          ? after.costUsd
          : before.costUsd === null
            ? null
            : after.costUsd - before.costUsd;
    rows.push({
      model,
      totals,
      reportedCostUsd: costUsd !== null && costUsd >= 0 ? costUsd : null,
    });
  }
  return rows;
}

/** Until the first rates arrive; no real version is empty. */
export const EMPTY_RATES: UsageRates = { table: new Map(), overrides: new Map(), version: "" };

/** Prices a turn the way the usage breakdown prices the same tokens. */
export function priceTurn(turn: RecordedTurn, rates: UsageRates): ThreadTurnUsage {
  const models = turn.models.map((row): ThreadUsageModel => {
    const priced = priceUsage(
      rates.table,
      // Stored turns predate fast-mode attribution; retain their standard-rate estimate.
      { ...row, fast: false },
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
    turnId: turn.turnId as TurnId,
    completedAt: turn.completedAt,
    totalTokens: models.reduce((sum, model) => sum + model.totalTokens, 0),
    costUsd: models.reduce((sum, model) => sum + model.costUsd, 0),
    models,
  };
}

/** True when no model in the turn had a price, so its cost is unknown rather than zero. */
export function isTurnUnpriced(turn: ThreadTurnUsage): boolean {
  return turn.models.every((model) => model.costSource === "unpriced");
}

export function sumTurns(turns: Iterable<ThreadTurnUsage>): ThreadUsageTotals {
  let totals: ThreadUsageTotals = { totalTokens: 0, costUsd: 0, turns: 0, unpricedTurns: 0 };
  for (const turn of turns) {
    totals = {
      totalTokens: totals.totalTokens + turn.totalTokens,
      costUsd: totals.costUsd + turn.costUsd,
      turns: totals.turns + 1,
      unpricedTurns: totals.unpricedTurns + (isTurnUnpriced(turn) ? 1 : 0),
    };
  }
  return totals;
}

/** Collapses rows that name the same model, e.g. after normalizing their ids. */
export function mergeModelRows(rows: readonly ModelUsageRow[]): readonly ModelUsageRow[] {
  const byModel = new Map<string, ModelUsageRow>();
  for (const row of rows) {
    const previous = byModel.get(row.model);
    byModel.set(
      row.model,
      previous
        ? {
            model: row.model,
            totals: addTotals(previous.totals, row.totals),
            reportedCostUsd: sumNullable(previous.reportedCostUsd, row.reportedCostUsd),
          }
        : row,
    );
  }
  return [...byModel.values()];
}
