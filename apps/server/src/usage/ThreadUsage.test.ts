import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  UsageDay,
  type UsageModelPriceOverride,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadUsage from "./ThreadUsage.ts";
import * as UsageService from "./UsageService.ts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");

const table = parseRateTable({
  "claude-opus-5-5": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
});

/** Custom prices the stubbed usage service serves; tests change them between reads. */
let priceOverrides: Record<string, UsageModelPriceOverride> = {};

const usageLayer = Layer.succeed(
  UsageService.UsageService,
  UsageService.UsageService.of({
    readSummary: () => Effect.die("not used"),
    refreshRates: Effect.die("not used"),
    currentRates: Effect.sync(() => ({
      table,
      overrides: createOverrideRateTable(priceOverrides),
      aliases: new Map(),
    })),
  }),
);

const TestLayer = ThreadUsage.layer.pipe(
  Layer.provide(usageLayer),
  Layer.provideMerge(ProjectionStoreV2.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const createThread = Effect.fn("createThread")(function* (threadId: ThreadId, model: string) {
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
  const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:provider-thread`),
    type: "provider-thread.updated",
    threadId,
    driver,
    occurredAt: now,
    payload: {
      id: ProviderThreadId.make(`provider-thread:${threadId}`),
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

/** A finished run with one provider turn that used `inputTokens` and `outputTokens`. */
const finishRun = Effect.fn("finishRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly model: string;
  readonly completedAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}) {
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
  const suffix = `${input.threadId}:${input.ordinal}`;
  const runId = RunId.make(`run:${suffix}`);
  const attemptId = RunAttemptId.make(`attempt:${suffix}`);
  const nodeId = NodeId.make(`node:${suffix}`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:${input.threadId}`);
  const providerTurnId = ProviderTurnId.make(`provider-turn:${suffix}`);
  const completedAt = DateTime.makeUnsafe(input.completedAt);

  yield* projections.apply({
    id: EventId.make(`event:${suffix}:run`),
    type: "run.created",
    threadId: input.threadId,
    runId,
    occurredAt: completedAt,
    payload: {
      id: runId,
      threadId: input.threadId,
      ordinal: input.ordinal,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: input.model },
      providerThreadId,
      userMessageId: MessageId.make(`message:${suffix}`),
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: completedAt,
      startedAt: completedAt,
      completedAt,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* projections.apply({
    id: EventId.make(`event:${suffix}:attempt`),
    type: "run-attempt.created",
    threadId: input.threadId,
    runId,
    nodeId,
    driver,
    occurredAt: completedAt,
    payload: {
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: nodeId,
      providerInstanceId,
      providerThreadId,
      providerTurnId,
      reason: "initial",
      status: "completed",
      startedAt: completedAt,
      completedAt,
    },
  });
  yield* projections.apply({
    id: EventId.make(`event:${suffix}:provider-turn`),
    type: "provider-turn.updated",
    threadId: input.threadId,
    nodeId,
    driver,
    occurredAt: completedAt,
    payload: {
      id: providerTurnId,
      providerThreadId,
      nodeId,
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: input.ordinal,
      status: "completed",
      startedAt: completedAt,
      completedAt,
      turnTokenUsage: {
        usageStatus: "complete",
        usageScope: "main_agent",
        hasSubagents: false,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      },
    },
  });
  return runId;
});

const window = (day: string, extra: Partial<UsageSummaryInput> = {}): UsageSummaryInput => ({
  sinceDay: UsageDay.make(day),
  untilDay: UsageDay.make(day),
  timeZone: "UTC",
  ...extra,
});

it.layer(TestLayer)("ThreadUsage", (it) => {
  it.effect("prices a thread's runs when read, so a later custom price reaches them", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsage.ThreadUsage;
      const threadId = ThreadId.make("thread:priced-when-read");
      yield* createThread(threadId, "claude-opus-5-5");
      const firstRun = yield* finishRun({
        threadId,
        ordinal: 1,
        model: "claude-opus-5-5[1m]",
        completedAt: "2026-10-05T10:00:00.000Z",
        inputTokens: 1_000_000,
        outputTokens: 200_000,
      });
      const secondRun = yield* finishRun({
        threadId,
        ordinal: 2,
        model: "unpriced-model",
        completedAt: "2026-10-05T11:00:00.000Z",
        inputTokens: 500,
        outputTokens: 0,
      });

      priceOverrides = {};
      const before = yield* threadUsage.readThreadUsage({ threadId });
      assert.deepStrictEqual(
        before.turns.map((turn) => [turn.runId, turn.totalTokens, turn.costUsd]),
        [
          [firstRun, 1_200_000, 2],
          [secondRun, 500, 0],
        ],
      );
      assert.deepStrictEqual(before.turns[0]?.models, [
        {
          model: "claude-opus-5-5",
          totalTokens: 1_200_000,
          costUsd: 2,
          costSource: "modelPriced",
          customPrice: false,
        },
      ]);
      assert.strictEqual(before.turns[1]?.models[0]?.costSource, "unpriced");

      priceOverrides = {
        "unpriced-model": { inputCostPerMillionTokens: 2000, outputCostPerMillionTokens: 2000 },
      };
      const after = yield* threadUsage.readThreadUsage({ threadId });
      assert.deepStrictEqual(after.turns[1]?.models, [
        {
          model: "unpriced-model",
          totalTokens: 500,
          costUsd: 1,
          costSource: "modelPriced",
          customPrice: true,
        },
      ]);
      priceOverrides = {};
    }),
  );

  it.effect("reports no usage for a thread that has none or does not exist", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsage.ThreadUsage;
      const threadId = ThreadId.make("thread:no-usage");
      yield* createThread(threadId, "claude-opus-5-5");

      assert.deepStrictEqual(yield* threadUsage.readThreadUsage({ threadId }), {
        threadId,
        turns: [],
      });
      const missing = ThreadId.make("thread:missing");
      assert.deepStrictEqual(yield* threadUsage.readThreadUsage({ threadId: missing }), {
        threadId: missing,
        turns: [],
      });
    }),
  );

  it.effect("totals each thread's runs that finished inside the window", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsage.ThreadUsage;
      const inside = ThreadId.make("thread:window-inside");
      const outside = ThreadId.make("thread:window-outside");
      yield* createThread(inside, "claude-opus-5-5");
      yield* createThread(outside, "claude-opus-5-5");
      // One run before the window and two inside it.
      yield* finishRun({
        threadId: inside,
        ordinal: 1,
        model: "claude-opus-5-5",
        completedAt: "2026-09-19T23:59:00.000Z",
        inputTokens: 9_000_000,
        outputTokens: 0,
      });
      yield* finishRun({
        threadId: inside,
        ordinal: 2,
        model: "claude-opus-5-5",
        completedAt: "2026-09-20T09:00:00.000Z",
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      yield* finishRun({
        threadId: inside,
        ordinal: 3,
        model: "claude-opus-5-5",
        completedAt: "2026-09-20T23:30:00.000Z",
        inputTokens: 2_000_000,
        outputTokens: 0,
      });
      yield* finishRun({
        threadId: outside,
        ordinal: 1,
        model: "claude-opus-5-5",
        completedAt: "2026-09-21T00:00:00.000Z",
        inputTokens: 4_000_000,
        outputTokens: 0,
      });

      const day = yield* threadUsage.listThreadUsage(window("2026-09-20"));
      assert.deepStrictEqual(day.threads, [
        {
          threadId: inside,
          totalTokens: 3_000_000,
          costUsd: 3,
          turns: 2,
          unpricedTurns: 0,
          lastTurnAt: "2026-09-20T23:30:00.000Z",
          models: ["claude-opus-5-5"],
        },
      ]);

      const hourly = yield* threadUsage.listThreadUsage(
        window("2026-09-20", {
          resolution: "hour",
          sinceTime: "2026-09-20T08:00:00.000Z",
          untilTime: "2026-09-20T10:00:00.000Z",
        }),
      );
      assert.deepStrictEqual(
        hourly.threads.map((thread) => [thread.threadId, thread.turns, thread.totalTokens]),
        [[inside, 1, 1_000_000]],
      );

      const empty = yield* threadUsage.listThreadUsage(window("2026-08-01"));
      assert.deepStrictEqual(empty.threads, []);
    }),
  );

  it.effect("rejects an hourly window without its instants, as a usage summary does", () =>
    Effect.gen(function* () {
      const threadUsage = yield* ThreadUsage.ThreadUsage;
      const error = yield* threadUsage
        .listThreadUsage(window("2026-09-20", { resolution: "hour" }))
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "invalidWindow");
    }),
  );
});
