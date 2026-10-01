import type { ThreadTotals } from "@t3tools/shared/usageMerge";

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

export function sortThreadRows(
  rows: readonly ThreadUsageRow[],
  sort: ThreadSort,
): readonly ThreadUsageRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const compare = (left: ThreadUsageRow, right: ThreadUsageRow): number => {
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
