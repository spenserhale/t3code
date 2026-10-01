/**
 * ThreadUsageBackfill - fills in thread usage for turns nobody recorded live.
 *
 * Turns that finished before usage tracking existed, or while another build
 * ran the same state directory, left no row in the sidebar store. The
 * provider's own transcripts still hold their usage, so each missing turn is
 * rebuilt from the transcript records written from its start until the next
 * turn starts.
 *
 * Rows are keyed by the real turn id, which makes this safe to run at every
 * start: a turn that is already recorded or was already searched for is
 * skipped, so a start with nothing new costs no transcript scan.
 *
 * Transcript usage includes subagents. Live Claude turns do too; live Codex
 * and OpenCode turns count the main agent only, so a backfilled turn of theirs
 * can read higher than a live one.
 *
 * @module ThreadUsageBackfill
 */
import { UsageDay } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { UsageService, type SessionRecord } from "../usage/UsageService.ts";
import { ThreadUsageService } from "./ThreadUsage.ts";
import { mergeModelRows, type RecordedTurn } from "./turnUsage.ts";

/** Matches how long the usage scan keeps transcript history. */
const BACKFILL_DAYS = 90;

/** Where each driver keeps the provider's own session id in its resume cursor. */
const SESSION_ID_FIELD: Readonly<Record<string, string>> = {
  claudeAgent: "resume",
  codex: "threadId",
  grok: "sessionId",
};

export function providerSessionId(driver: string, resumeCursor: unknown): string | null {
  const field = SESSION_ID_FIELD[driver];
  if (field === undefined || typeof resumeCursor !== "object" || resumeCursor === null) return null;
  const value = (resumeCursor as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface TurnWindow {
  readonly turnId: string;
  readonly startedAtMs: number;
  readonly completedAt: string;
  /**
   * Already recorded or searched for, or not finished; it still claims its
   * records, so they are not credited to the turn before it, but is not rebuilt.
   */
  readonly settled: boolean;
}

/**
 * Gives every record to the latest turn that had started by then, so work that
 * outlives a turn (subagents, background tasks) still counts toward it. Records
 * from before the first turn were not driven through T3 Code and are left out.
 * A turn with no records produces nothing.
 */
export function rebuildTurns(
  threadId: string,
  turns: readonly TurnWindow[],
  records: readonly SessionRecord[],
): readonly RecordedTurn[] {
  const ordered = turns.toSorted((left, right) => left.startedAtMs - right.startedAtMs);
  const recordsByTurn = new Map<TurnWindow, SessionRecord[]>();
  for (const record of records) {
    const owner = ordered.findLast((turn) => turn.startedAtMs <= record.timestampMs);
    if (owner === undefined || owner.settled) continue;
    recordsByTurn.set(owner, [...(recordsByTurn.get(owner) ?? []), record]);
  }

  return [...recordsByTurn].map(([turn, owned]): RecordedTurn => ({
    threadId,
    turnId: turn.turnId,
    completedAt: turn.completedAt,
    models: mergeModelRows(
      owned.map((record) => ({
        model: record.model,
        totals: record.totals,
        reportedCostUsd: record.reportedCostUsd,
      })),
    ),
  }));
}

const backfill = Effect.gen(function* () {
  const threadUsage = yield* ThreadUsageService;
  const usage = yield* UsageService;
  const directory = yield* ProviderSessionDirectory;
  const turnRepository = yield* ProjectionTurnRepository;

  const missingByThread = new Map<string, { sessionId: string; turns: TurnWindow[] }>();
  for (const binding of yield* directory.listBindings()) {
    const sessionId = providerSessionId(binding.provider, binding.resumeCursor);
    if (sessionId === null) continue;
    const settled = threadUsage.settledTurnIds(binding.threadId);
    // Running turns are left for live recording, but still bound the turn before them.
    const turns = (yield* turnRepository.listByThreadId({ threadId: binding.threadId })).flatMap(
      (turn): TurnWindow[] =>
        turn.startedAt === null
          ? []
          : [
              {
                turnId: turn.turnId ?? "",
                startedAtMs: Date.parse(turn.startedAt),
                completedAt: turn.completedAt ?? "",
                settled:
                  turn.turnId === null || turn.completedAt === null || settled.has(turn.turnId),
              },
            ],
    );
    if (turns.some((turn) => !turn.settled)) {
      missingByThread.set(binding.threadId, { sessionId, turns });
    }
  }
  if (missingByThread.size === 0) return;

  const now = yield* DateTime.now;
  const day = (instant: DateTime.DateTime) =>
    UsageDay.make(DateTime.formatIso(instant).slice(0, 10));
  const records = yield* usage.readSessionRecords({
    sessionIds: new Set([...missingByThread.values()].map((entry) => entry.sessionId)),
    sinceDay: day(DateTime.subtract(now, { days: BACKFILL_DAYS })),
    untilDay: day(now),
  });

  let added = 0;
  for (const [threadId, { sessionId, turns }] of missingByThread) {
    added += threadUsage.importTurns(
      rebuildTurns(
        threadId,
        turns,
        records.filter((record) => record.sessionId === sessionId),
      ),
    );
    // A finished turn's transcript never grows, so one search is enough.
    threadUsage.markTurnsChecked(
      threadId,
      turns.filter((turn) => !turn.settled).map((turn) => turn.turnId),
    );
  }
  yield* Effect.logInfo("thread usage backfilled", { threads: missingByThread.size, turns: added });
});

/** Runs once per start, in the background; a failure only means no backfill this time. */
export const layer = Layer.effectDiscard(
  backfill.pipe(
    Effect.catchCause((cause) => Effect.logWarning("thread usage backfill failed", cause)),
    Effect.forkScoped,
  ),
);
