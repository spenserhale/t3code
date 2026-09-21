import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextThreadSort, sortThreadRows, type ThreadUsageRow } from "./usageThreads";

const row = (title: string | null, costUsd: number, totalTokens: number): ThreadUsageRow => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(title ?? "gone"),
  title,
  costUsd,
  totalTokens,
  turns: 1,
  unpricedTurns: 0,
  lastTurnAt: "2026-09-21T00:00:00.000Z",
  models: [],
});

describe("thread usage sorting", () => {
  const rows = [row("Beta", 1, 900), row("Alpha", 5, 100), row(null, 3, 500)];
  const titles = (sorted: readonly ThreadUsageRow[]) => sorted.map((entry) => entry.title);

  it("orders by the chosen column in either direction", () => {
    expect(titles(sortThreadRows(rows, { key: "cost", direction: "desc" }))).toEqual([
      "Alpha",
      null,
      "Beta",
    ]);
    expect(titles(sortThreadRows(rows, { key: "tokens", direction: "asc" }))).toEqual([
      "Alpha",
      null,
      "Beta",
    ]);
    expect(titles(sortThreadRows(rows, { key: "thread", direction: "asc" }))).toEqual([
      null,
      "Alpha",
      "Beta",
    ]);
  });

  it("flips the active column and opens a new one in its natural direction", () => {
    expect(nextThreadSort({ key: "cost", direction: "desc" }, "cost")).toEqual({
      key: "cost",
      direction: "asc",
    });
    expect(nextThreadSort({ key: "cost", direction: "asc" }, "tokens")).toEqual({
      key: "tokens",
      direction: "desc",
    });
    expect(nextThreadSort({ key: "cost", direction: "desc" }, "thread")).toEqual({
      key: "thread",
      direction: "asc",
    });
  });
});
