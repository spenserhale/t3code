import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeThreadUsage,
  nextThreadSort,
  sortThreadRows,
  type EnvironmentThreadUsage,
  type ThreadUsageRow,
} from "./usageThreads";

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

describe("mergeThreadUsage", () => {
  const totals = (threadId: string) => ({
    threadId: ThreadId.make(threadId),
    totalTokens: 100,
    costUsd: 1,
    turns: 1,
    unpricedTurns: 0,
    lastTurnAt: "2026-09-21T00:00:00.000Z",
    models: ["example-model"],
  });
  const environment = (
    id: string,
    fields: Partial<EnvironmentThreadUsage>,
  ): EnvironmentThreadUsage => ({
    environmentId: EnvironmentId.make(id),
    label: id,
    supported: true,
    isPending: false,
    failed: false,
    threads: null,
    ...fields,
  });

  it("keeps the same thread id apart per environment", () => {
    const merged = mergeThreadUsage([
      environment("env-a", { threads: [totals("thread-1")] }),
      environment("env-b", { threads: [totals("thread-1")] }),
    ]);
    expect(merged.threads.map((thread) => [thread.environmentId, thread.threadId])).toEqual([
      ["env-a", "thread-1"],
      ["env-b", "thread-1"],
    ]);
    expect(merged.isPending).toBe(false);
  });

  it("names the environments that cannot report, failed, or are still answering", () => {
    const merged = mergeThreadUsage([
      environment("official", { supported: false }),
      environment("broken", { failed: true }),
      environment("slow", { isPending: true }),
      // A refetch in flight keeps showing the last answer.
      environment("refreshing", { isPending: true, threads: [totals("thread-2")] }),
    ]);
    expect(merged.unsupportedEnvironments).toEqual(["official"]);
    expect(merged.failedEnvironments).toEqual(["broken"]);
    expect(merged.isPending).toBe(true);
    expect(merged.threads).toHaveLength(1);
  });
});
