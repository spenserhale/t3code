// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ThreadId,
  UsageDay,
  type TurnTokenUsage,
  type UsageModelPriceOverride,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as UsageService from "../usage/UsageService.ts";
import { createOverrideRateTable, type RateTable } from "../usage/usagePricing.ts";
import * as SidebarStore from "./SidebarStore.ts";
import { ThreadUsageService, layer, type TurnUsageReport } from "./ThreadUsage.ts";

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

const report = (turnId: string, overrides: Partial<TurnUsageReport> = {}): TurnUsageReport => ({
  threadId: "thread-1",
  turnId,
  completedAt: "2026-09-21T00:00:00.000Z",
  driver: ProviderDriverKind.make("codex"),
  model: "example-model",
  usage: usage(),
  ...overrides,
});

// USD per token: $1/M input, $2/M output, $0.10/M cache reads, $1.25/M cache writes.
const RATES: RateTable = new Map([
  [
    "example-model",
    {
      inputCostPerToken: 1e-6,
      outputCostPerToken: 2e-6,
      cacheReadCostPerToken: 1e-7,
      cacheCreationCostPerToken: 1.25e-6,
    },
  ],
]);
// 200 uncached, 700 cache reads, 100 cache writes and 50 output tokens at RATES.
const TURN_COST = 200e-6 + 700e-7 + 100 * 1.25e-6 + 50 * 2e-6;

/** Rate table fixed; custom prices editable mid-test, as a user would on the Usage page. */
const pricing = (customPrices: Record<string, UsageModelPriceOverride>) =>
  Layer.effect(
    UsageService.UsageService,
    Effect.gen(function* () {
      const base = yield* UsageService.UsageService;
      return {
        ...base,
        currentRates: Effect.sync(() => ({
          table: RATES,
          overrides: createOverrideRateTable(customPrices),
          version: `test:${Object.entries(customPrices)
            .map(([model, price]) => `${model}=${price.inputCostPerMillionTokens}`)
            .join("|")}`,
        })),
      };
    }),
  ).pipe(Layer.provide(UsageService.layerTest));

const fileStore = (filename: string) =>
  Layer.effect(
    SidebarStore.SidebarStore,
    Effect.acquireRelease(
      Effect.sync(() => ({ database: SidebarStore.openSidebarDatabase(filename) })),
      ({ database }) => Effect.sync(() => database.close()),
    ),
  );

const serviceWith = (
  store: Layer.Layer<SidebarStore.SidebarStore>,
  customPrices: Record<string, UsageModelPriceOverride> = {},
) => layer.pipe(Layer.provide(store), Layer.provide(pricing(customPrices)));

const tempDirectory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sidebar-store-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

describe("ThreadUsageService", () => {
  it.effect("adds up a thread's turns and counts a repeated turn once", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsageService;
      assert.isNull(threadUsage.getThreadUsage("thread-1"));

      yield* threadUsage.recordTurn(report("turn-1"));
      yield* threadUsage.recordTurn(report("turn-1"));
      yield* threadUsage.recordTurn(report("turn-2", { model: "unknown-model" }));
      yield* threadUsage.readThreadUsage(ThreadId.make("thread-1"));

      const totals = threadUsage.getThreadUsage("thread-1");
      assert.strictEqual(totals?.totalTokens, 2_100);
      assert.strictEqual(totals?.turns, 2);
      assert.strictEqual(totals?.unpricedTurns, 1);
      assert.closeTo(totals?.costUsd ?? 0, TURN_COST, 1e-12);
    }).pipe(Effect.provide(serviceWith(SidebarStore.layerMemory))),
  );

  it.effect("prices past turns with custom prices saved after they ran", () => {
    const customPrices: Record<string, UsageModelPriceOverride> = {};
    return Effect.gen(function* () {
      const threadUsage = yield* ThreadUsageService;
      yield* threadUsage.recordTurn(report("turn-1", { model: "self-hosted-model" }));

      const before = yield* threadUsage.readThreadUsage(ThreadId.make("thread-1"));
      assert.deepStrictEqual(before.turns[0]?.models, [
        {
          model: "self-hosted-model",
          totalTokens: 1_050,
          costUsd: 0,
          costSource: "unpriced",
          customPrice: false,
        },
      ]);

      customPrices["self-hosted-model"] = {
        inputCostPerMillionTokens: 1_000,
        outputCostPerMillionTokens: 1_000,
      };
      const after = yield* threadUsage.readThreadUsage(ThreadId.make("thread-1"));
      assert.strictEqual(after.turns[0]?.models[0]?.customPrice, true);
      assert.closeTo(after.turns[0]?.costUsd ?? 0, 1.05, 1e-9);
      // The synchronous shell read follows once the new rates have been seen.
      assert.closeTo(threadUsage.getThreadUsage("thread-1")?.costUsd ?? 0, 1.05, 1e-9);
    }).pipe(Effect.provide(serviceWith(SidebarStore.layerMemory, customPrices)));
  });

  it.effect("stores a Claude turn as its share of the session's running totals", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsageService;
      const claude = (turnId: string, opus: number, haiku: number, cost: number) =>
        report(turnId, {
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "claude-opus-5-5",
          modelUsage: {
            "claude-opus-5-5[1m]": { inputTokens: opus, outputTokens: 10, costUSD: cost },
            "claude-haiku-4-5-20251001": { inputTokens: haiku, outputTokens: 0, costUSD: 0.01 },
          },
        });
      yield* threadUsage.recordTurn(claude("turn-1", 1_000, 500, 1));
      yield* threadUsage.recordTurn(claude("turn-2", 1_600, 500, 1.5));

      const { turns } = yield* threadUsage.readThreadUsage(ThreadId.make("thread-1"));
      assert.deepStrictEqual(
        turns.map((turn) =>
          turn.models.map((model) => [model.model, model.totalTokens, model.costUsd]),
        ),
        [
          [
            ["claude-opus-5-5", 1_010, 1],
            ["claude-haiku-4-5-20251001", 500, 0.01],
          ],
          // Haiku did nothing in the second turn, so it has no row.
          [["claude-opus-5-5", 600, 0.5]],
        ],
      );
    }).pipe(Effect.provide(serviceWith(SidebarStore.layerMemory))),
  );

  it.effect("takes a turn whole after the provider session started over", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsageService;
      const claude = (turnId: string, inputTokens: number) =>
        report(turnId, {
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "claude-opus-5-5",
          modelUsage: { "claude-opus-5-5": { inputTokens, outputTokens: 0 } },
        });
      yield* threadUsage.recordTurn(claude("turn-1", 100));
      // Stopped and resumed: the new session's totals start from zero, and here
      // they already exceed the old ones, so only the reset reveals it.
      threadUsage.forgetSession("thread-1");
      yield* threadUsage.recordTurn(claude("turn-2", 300));

      const { turns } = yield* threadUsage.readThreadUsage(ThreadId.make("thread-1"));
      assert.deepStrictEqual(
        turns.map((turn) => turn.totalTokens),
        [100, 300],
      );
    }).pipe(Effect.provide(serviceWith(SidebarStore.layerMemory))),
  );

  it.effect("records OpenCode turns under the model id its usage database uses", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsageService;
      yield* threadUsage.recordTurn(
        report("turn-1", {
          driver: ProviderDriverKind.make("opencode"),
          model: "zai-coding-plan/glm-5",
        }),
      );
      const { turns } = yield* threadUsage.readThreadUsage(ThreadId.make("thread-1"));
      assert.strictEqual(turns[0]?.models[0]?.model, "glm-5");
    }).pipe(Effect.provide(serviceWith(SidebarStore.layerMemory))),
  );

  it.effect("lists threads whose turns fall on the window's days in its time zone", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsageService;
      // 06:30Z on the 21st is still the 20th in Los Angeles.
      yield* threadUsage.recordTurn(report("turn-1", { completedAt: "2026-09-21T06:30:00.000Z" }));
      yield* threadUsage.recordTurn(
        report("turn-2", { completedAt: "2026-09-21T20:00:00.000Z", model: "other-model" }),
      );
      yield* threadUsage.recordTurn(
        report("turn-3", { threadId: "thread-2", completedAt: "2026-09-25T12:00:00.000Z" }),
      );
      const window = (sinceDay: string, untilDay: string) =>
        threadUsage.listThreadUsage({
          timeZone: "America/Los_Angeles",
          sinceDay: UsageDay.make(sinceDay),
          untilDay: UsageDay.make(untilDay),
        });

      const both = yield* window("2026-09-20", "2026-09-21");
      assert.strictEqual(both.length, 1);
      assert.deepStrictEqual(
        { ...both[0], costUsd: undefined },
        {
          threadId: ThreadId.make("thread-1"),
          totalTokens: 2_100,
          costUsd: undefined,
          turns: 2,
          unpricedTurns: 1,
          lastTurnAt: "2026-09-21T20:00:00.000Z",
          models: ["example-model", "other-model"],
        },
      );
      assert.strictEqual((yield* window("2026-09-21", "2026-09-21"))[0]?.turns, 1);
      assert.deepStrictEqual(yield* window("2026-09-22", "2026-09-24"), []);
    }).pipe(Effect.provide(serviceWith(SidebarStore.layerMemory))),
  );

  it.effect("restores turns from the store after a restart", () =>
    Effect.gen(function* () {
      const store = NodePath.join(yield* tempDirectory, "sidebar.sqlite");

      yield* Effect.gen(function* () {
        yield* (yield* ThreadUsageService).recordTurn(report("turn-1"));
      }).pipe(Effect.provide(serviceWith(fileStore(store))));

      const restored = yield* Effect.gen(function* () {
        const threadUsage = yield* ThreadUsageService;
        assert.isTrue(threadUsage.settledTurnIds("thread-1").has("turn-1"));
        return yield* threadUsage.readThreadUsage(ThreadId.make("thread-1"));
      }).pipe(Effect.provide(serviceWith(fileStore(store))));
      assert.strictEqual(restored.turns.length, 1);
      assert.strictEqual(restored.turns[0]?.totalTokens, 1_050);
    }).pipe(Effect.scoped),
  );

  it.effect("carries turns over from the old table under usage ids, without stored costs", () =>
    Effect.gen(function* () {
      const store = NodePath.join(yield* tempDirectory, "sidebar.sqlite");
      // The store as the first release left it: priced rows, schema version 2.
      const old = new NodeSqlite.DatabaseSync(store);
      old.exec(`CREATE TABLE thread_turn_usage (
          thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, completed_at TEXT NOT NULL,
          model TEXT NOT NULL, uncached_input_tokens INTEGER NOT NULL,
          cached_input_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
          cost_usd REAL NOT NULL, cost_source TEXT NOT NULL,
          PRIMARY KEY (thread_id, turn_id)) WITHOUT ROWID;
        CREATE TABLE thread_turn_checked (
          thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          PRIMARY KEY (thread_id, turn_id)) WITHOUT ROWID;
        INSERT INTO thread_turn_usage VALUES
          ('thread-1', 'turn-1', '2026-09-21T00:00:00.000Z', 'example-model[1m]',
           200, 700, 100, 50, 20, 6.45, 'providerReported');
        PRAGMA user_version = 2;`);
      old.close();

      const detail = yield* Effect.gen(function* () {
        return yield* (yield* ThreadUsageService).readThreadUsage(ThreadId.make("thread-1"));
      }).pipe(Effect.provide(serviceWith(fileStore(store))));
      assert.strictEqual(detail.turns[0]?.models[0]?.model, "example-model");
      assert.strictEqual(detail.turns[0]?.models[0]?.costSource, "modelPriced");
      assert.closeTo(detail.turns[0]?.costUsd ?? 0, TURN_COST, 1e-12);
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
