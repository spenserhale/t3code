/**
 * ThreadUsage - tokens and estimated cost per thread and per run.
 *
 * Reads the provider turns orchestration already projects and prices them when
 * asked, with the usage service's rates. It stores nothing and keeps no cache,
 * so a new price or model mapping reaches every past run at once.
 *
 * Only work driven through T3 Code is counted, and only for providers whose
 * adapters report turn usage.
 *
 * @module ThreadUsage
 */
import {
  ThreadId,
  UsageReadError,
  type ThreadUsageDetail,
  type ThreadUsageInput,
  type ThreadUsageList,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as UsageService from "./UsageService.ts";
import { priceTurn, recordedTurns, threadTotals, usageWindow } from "./turnUsage.ts";

export class ThreadUsage extends Context.Service<
  ThreadUsage,
  {
    /** Every run of a thread that reported usage, oldest first, priced at the current rates. */
    readonly readThreadUsage: (input: ThreadUsageInput) => Effect.Effect<ThreadUsageDetail>;
    /** Totals per thread for the window a usage summary would take, bounded the same way. */
    readonly listThreadUsage: (
      input: UsageSummaryInput,
    ) => Effect.Effect<ThreadUsageList, UsageReadError>;
  }
>()("t3/usage/ThreadUsage") {}

const USAGE_FIELDS = ["runs", "attempts", "providerTurns", "providerThreads"] as const;

const isoInstant = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

const make = Effect.gen(function* () {
  const usage = yield* UsageService.UsageService;
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;

  const readRecordedTurns = (threadId: ThreadId) =>
    projections.getThreadRecords(threadId, USAGE_FIELDS).pipe(Effect.map(recordedTurns));

  const readThreadUsage = Effect.fn("ThreadUsage.readThreadUsage")(function* (
    input: ThreadUsageInput,
  ) {
    // Usage annotates a thread: one that cannot be read shows none, not an error.
    const turns = yield* readRecordedTurns(input.threadId).pipe(
      Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed([])),
      Effect.catch((error) =>
        Effect.logWarning("thread usage could not be read", error).pipe(Effect.as([])),
      ),
    );
    if (turns.length === 0) return { threadId: input.threadId, turns: [] };
    const rates = yield* usage.currentRates;
    return { threadId: input.threadId, turns: turns.map((turn) => priceTurn(turn, rates)) };
  });

  const listThreadUsage = Effect.fn("ThreadUsage.listThreadUsage")(function* (
    input: UsageSummaryInput,
  ) {
    const window = usageWindow(input);
    if (window === null) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: "Hourly thread usage requires valid sinceTime and untilTime instants",
      });
    }
    // Threads with any turn finished near the window; each is then read whole,
    // because a run is counted where its last provider turn finished.
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT DISTINCT thread_id
      FROM orchestration_v2_projection_provider_turns
      WHERE completed_at >= ${isoInstant(window.lowerMs)}
        AND completed_at < ${isoInstant(window.upperMs)}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Thread usage could not be read.",
            cause,
          }),
      ),
    );
    if (rows.length === 0) return { threads: [] };
    const rates = yield* usage.currentRates;
    const threads = yield* Effect.forEach(rows, (row) => {
      const threadId = ThreadId.make(row.thread_id);
      return readRecordedTurns(threadId).pipe(
        Effect.map((turns) =>
          threadTotals(
            threadId,
            turns
              .filter((turn) => window.contains(turn.completedAtMs))
              .map((turn) => priceTurn(turn, rates)),
          ),
        ),
        // One unreadable thread must not hide every other thread's usage.
        Effect.orElseSucceed(() => null),
      );
    });
    return { threads: threads.filter((thread) => thread !== null) };
  });

  return ThreadUsage.of({ readThreadUsage, listThreadUsage });
});

export const layer = Layer.effect(ThreadUsage, make);
