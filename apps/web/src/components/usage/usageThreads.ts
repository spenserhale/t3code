import type { EnvironmentId, UsageThreadTotals } from "@t3tools/contracts";

/** One thread's usage, scoped by environment because thread ids are only unique within one. */
export interface ThreadTotals extends UsageThreadTotals {
  readonly environmentId: EnvironmentId;
}

/** Every turn lacked rates, so the cost is unknown rather than zero. */
export function isThreadCostUnknown(thread: ThreadTotals): boolean {
  return thread.turns > 0 && thread.unpricedTurns >= thread.turns;
}

/** What one connected environment answered for a window. */
export interface EnvironmentThreadUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** `false` when the server does not report thread usage; it is then never asked. */
  readonly supported: boolean;
  readonly isPending: boolean;
  readonly failed: boolean;
  readonly threads: readonly UsageThreadTotals[] | null;
}

export interface ThreadUsageTotals {
  /** Unsorted; the table orders it by the column it shows. */
  readonly threads: readonly ThreadTotals[];
  /** Labels of environments whose server cannot report thread usage. */
  readonly unsupportedEnvironments: readonly string[];
  /** Labels of environments that can, and failed to this time. */
  readonly failedEnvironments: readonly string[];
  /** True while an environment that was asked has neither answered nor failed. */
  readonly isPending: boolean;
}

/**
 * Thread totals come from each server's own turns, never from transcripts two
 * servers might share, so answers are simply laid side by side.
 */
export function mergeThreadUsage(
  environments: readonly EnvironmentThreadUsage[],
): ThreadUsageTotals {
  return {
    threads: environments.flatMap((environment) =>
      (environment.threads ?? []).map((thread) => ({
        environmentId: environment.environmentId,
        ...thread,
      })),
    ),
    unsupportedEnvironments: environments
      .filter((environment) => !environment.supported)
      .map((environment) => environment.label),
    failedEnvironments: environments
      .filter((environment) => environment.failed && environment.threads === null)
      .map((environment) => environment.label),
    isPending: environments.some(
      (environment) => environment.isPending && environment.threads === null,
    ),
  };
}

export type ThreadSortKey = "thread" | "cost" | "tokens" | "turns";

export interface ThreadSort {
  readonly key: ThreadSortKey;
  readonly direction: "asc" | "desc";
}

/** Numbers open largest-first, names A to Z; choosing the active column flips it. */
export function nextThreadSort(current: ThreadSort, key: ThreadSortKey): ThreadSort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: key === "thread" ? "asc" : "desc" };
}

export interface ThreadUsageRow extends ThreadTotals {
  /** `null` when the thread is no longer known to this client, e.g. deleted. */
  readonly title: string | null;
}

export function sortThreadRows<Row extends ThreadUsageRow>(
  rows: readonly Row[],
  sort: ThreadSort,
): readonly Row[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const compare = (left: Row, right: Row): number => {
    switch (sort.key) {
      case "thread":
        return (left.title ?? "").localeCompare(right.title ?? "");
      case "cost":
        return left.costUsd - right.costUsd;
      case "tokens":
        return left.totalTokens - right.totalTokens;
      case "turns":
        return left.turns - right.turns;
    }
  };
  return rows.toSorted(
    (left, right) =>
      sign * compare(left, right) ||
      // Most recently active first keeps equal rows in a stable, useful order.
      right.lastTurnAt.localeCompare(left.lastTurnAt),
  );
}
