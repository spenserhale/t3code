// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import type { TurnTokenUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as UsageService from "../usage/UsageService.ts";
import * as SidebarStore from "./SidebarStore.ts";
import { ThreadUsageService, layer, turnUsageToTotals } from "./ThreadUsage.ts";

const usage = (overrides: Partial<TurnTokenUsage> = {}): TurnTokenUsage =>
  ({
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    inputTokens: 1_000,
    cachedInputTokens: 700,
    cacheCreationTokens: 100,
    outputTokens: 50,
    reasoningTokens: 20,
    ...overrides,
  }) as TurnTokenUsage;

const report = (turnId: string, reportedCostUsd: number | null = 0.25) => ({
  threadId: "thread-1",
  turnId,
  completedAt: "2026-09-21T00:00:00.000Z",
  model: "example-model",
  usage: usage(),
  reportedCostUsd,
});

const fileStore = (filename: string) =>
  Layer.effect(
    SidebarStore.SidebarStore,
    Effect.acquireRelease(
      Effect.sync(() => ({ database: SidebarStore.openSidebarDatabase(filename) })),
      ({ database }) => Effect.sync(() => database.close()),
    ),
  );

const serviceWith = (store: Layer.Layer<SidebarStore.SidebarStore>) =>
  layer.pipe(Layer.provide(store), Layer.provide(UsageService.layerTest));

describe("turnUsageToTotals", () => {
  it("splits cache reads and writes out of the inclusive input count", () => {
    assert.deepStrictEqual(turnUsageToTotals(usage()), {
      uncachedInputTokens: 200,
      cachedInputTokens: 700,
      cacheCreationTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
    });
  });

  it("reports nothing for unavailable or empty usage", () => {
    assert.isNull(
      turnUsageToTotals({
        usageStatus: "unavailable",
        usageScope: "main_agent",
        hasSubagents: false,
      }),
    );
    assert.isNull(
      turnUsageToTotals(
        usage({ inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }),
      ),
    );
  });
});

describe("ThreadUsageService", () => {
  it.effect("adds up a thread's turns and counts a repeated turn once", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsageService;
      assert.isNull(threadUsage.getThreadUsage("thread-1"));

      yield* threadUsage.recordTurn(report("turn-1"));
      yield* threadUsage.recordTurn(report("turn-1"));
      yield* threadUsage.recordTurn(report("turn-2", null));

      assert.deepStrictEqual(threadUsage.getThreadUsage("thread-1"), {
        totalTokens: 2_100,
        costUsd: 0.25,
        turns: 2,
        unpricedTurns: 1,
      });
    }).pipe(Effect.provide(serviceWith(SidebarStore.layerMemory))),
  );

  it.effect("restores totals from the store after a restart", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sidebar-store-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const store = NodePath.join(directory, "sidebar.sqlite");

      yield* Effect.gen(function* () {
        yield* (yield* ThreadUsageService).recordTurn(report("turn-1"));
      }).pipe(Effect.provide(serviceWith(fileStore(store))));

      const restored = yield* Effect.gen(function* () {
        return (yield* ThreadUsageService).getThreadUsage("thread-1");
      }).pipe(Effect.provide(serviceWith(fileStore(store))));
      assert.strictEqual(restored?.turns, 1);
      assert.strictEqual(restored?.totalTokens, 1_050);
    }).pipe(Effect.scoped),
  );

  it.effect("stays silent when the store could not be opened", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsageService;
      yield* threadUsage.recordTurn(report("turn-1"));
      assert.isNull(threadUsage.getThreadUsage("thread-1"));
    }).pipe(
      Effect.provide(serviceWith(Layer.succeed(SidebarStore.SidebarStore, { database: null }))),
    ),
  );
});
