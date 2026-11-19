import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxChangeTracker,
  sortInboxThreadsByOrder,
  type InboxOrderOptions,
  type InboxOrderThreadInput,
} from "./threadOrder.ts";

const environmentId = EnvironmentId.make("environment-1");
const now = "2026-06-01T12:00:00.000Z";

function thread(id: string, overrides: Partial<InboxOrderThreadInput> = {}): InboxOrderThreadInput {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestRun: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function run(requestedAt: string, completedAt: string | null) {
  return { requestedAt, startedAt: requestedAt, completedAt };
}

function failed(requestedAt: string, completedAt: string): Partial<InboxOrderThreadInput> {
  return {
    latestRun: { ...run(requestedAt, completedAt), status: "failed" },
    runtime: { status: "failed", updatedAt: completedAt },
  };
}

function asking(kind: "approval" | "input", createdAt: string): Partial<InboxOrderThreadInput> {
  return {
    hasPendingApprovals: kind === "approval",
    hasPendingUserInput: kind === "input",
    source: {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request-1"),
        kind: kind === "approval" ? "command" : "user_input",
        createdAt: DateTime.makeUnsafe(createdAt),
      },
    },
  };
}

function memoryStore() {
  let saved: Readonly<Record<string, number>> = {};
  return {
    store: {
      load: () => saved,
      save: (changes: Readonly<Record<string, number>>) => {
        saved = { ...changes };
      },
    },
    saved: () => saved,
  };
}

const ids = (threads: readonly InboxOrderThreadInput[]) => threads.map((entry) => entry.id);

function order(
  threads: readonly InboxOrderThreadInput[],
  by: Parameters<typeof sortInboxThreadsByOrder>[1],
  options: Partial<InboxOrderOptions<InboxOrderThreadInput>> = {},
) {
  return ids(sortInboxThreadsByOrder(threads, by, { now, ...options }));
}

describe("sortInboxThreadsByOrder", () => {
  // A thread the user wrote to an hour ago must outrank one whose agent
  // finished more recently but that the user has not touched for two hours.
  const chattedRecently = thread("chatted-recently", {
    latestUserAuthoredMessageAt: "2026-06-01T11:00:00.000Z",
    latestRun: run("2026-06-01T11:00:00.000Z", "2026-06-01T11:05:00.000Z"),
  });
  const finishedRecently = thread("finished-recently", {
    latestUserAuthoredMessageAt: "2026-06-01T10:00:00.000Z",
    latestRun: run("2026-06-01T10:00:00.000Z", "2026-06-01T11:30:00.000Z"),
  });

  it("orders by the last message the user wrote", () => {
    expect(order([finishedRecently, chattedRecently], "last_user_message")).toEqual([
      "chatted-recently",
      "finished-recently",
    ]);
  });

  it("ignores agent-sent messages when the server reports authored ones", () => {
    const agentPinged = thread("agent-pinged", {
      latestUserMessageAt: "2026-06-01T11:50:00.000Z",
      latestUserAuthoredMessageAt: "2026-06-01T09:00:00.000Z",
    });
    expect(order([agentPinged, chattedRecently], "last_user_message")).toEqual([
      "chatted-recently",
      "agent-pinged",
    ]);
  });

  it("falls back to creation time for a thread with no user message", () => {
    const fresh = thread("fresh", { createdAt: "2026-06-01T11:59:00.000Z" });
    expect(order([chattedRecently, fresh], "last_user_message")).toEqual([
      "fresh",
      "chatted-recently",
    ]);
  });

  it("orders by the last run, wake, or unsettle for last status change", () => {
    const woke = thread("woke", { unsettledAt: "2026-06-01T11:45:00.000Z" });
    const snoozeWoke = thread("snooze-woke", { snoozedUntil: "2026-06-01T11:40:00.000Z" });
    expect(
      order([chattedRecently, snoozeWoke, finishedRecently, woke], "last_status_change"),
    ).toEqual(["woke", "snooze-woke", "finished-recently", "chatted-recently"]);
  });

  it("does not count a snooze wake time that is still in the future", () => {
    const stillSnoozing = thread("still-snoozing", { snoozedUntil: "2026-06-01T13:00:00.000Z" });
    expect(order([stillSnoozing, chattedRecently], "last_status_change")).toEqual([
      "chatted-recently",
      "still-snoozing",
    ]);
  });

  it("counts an early wake by its request, and the deadline passing later does not promote it", () => {
    // It asked at 11:20 while snoozed until 15:00. The thread's updatedAt moves
    // with every event, so it must not stand in for the wake time.
    const earlyWake = thread("early-wake", {
      ...asking("approval", "2026-06-01T11:20:00.000Z"),
      snoozedUntil: "2026-06-01T15:00:00.000Z",
      snoozedAt: "2026-06-01T08:00:00.000Z",
      runtime: { status: "waiting", updatedAt: "2026-06-01T11:59:00.000Z" },
    });
    expect(order([chattedRecently, earlyWake, finishedRecently], "last_status_change")).toEqual([
      "finished-recently",
      "early-wake",
      "chatted-recently",
    ]);

    const finishedLater = thread("finished-later", {
      latestRun: run("2026-06-01T13:00:00.000Z", "2026-06-01T14:00:00.000Z"),
    });
    expect(
      order([earlyWake, finishedLater], "last_status_change", { now: "2026-06-01T16:00:00.000Z" }),
    ).toEqual(["finished-later", "early-wake"]);
  });

  // The run began at 09:00 and the thread asked at 11:45; a completion at 11:30
  // must not outrank the question.
  it.each([{ kind: "approval" as const }, { kind: "input" as const }])(
    "counts when a thread asked for $kind, not just its run times",
    ({ kind }) => {
      const asked = thread("asked", {
        ...asking(kind, "2026-06-01T11:45:00.000Z"),
        latestRun: run("2026-06-01T09:00:00.000Z", null),
      });
      expect(order([chattedRecently, finishedRecently, asked], "last_status_change")).toEqual([
        "asked",
        "finished-recently",
        "chatted-recently",
      ]);
    },
  );

  it("groups by status rank, newest activity first within a group", () => {
    const needsInput = thread("needs-input");
    const rank = (entry: InboxOrderThreadInput) => (entry.id === "needs-input" ? 0 : 1);
    expect(
      order([chattedRecently, finishedRecently, needsInput], "status", { statusRank: rank }),
    ).toEqual(["needs-input", "finished-recently", "chatted-recently"]);
  });

  it("orders a status group by its latest request, not by when its run started", () => {
    const askedLate = thread("asked-late", {
      ...asking("approval", "2026-06-01T11:45:00.000Z"),
      latestRun: run("2026-06-01T09:00:00.000Z", null),
    });
    const askedEarly = thread("asked-early", {
      ...asking("approval", "2026-06-01T10:30:00.000Z"),
      latestRun: run("2026-06-01T10:00:00.000Z", null),
    });
    const rank = (entry: InboxOrderThreadInput) => (entry.hasPendingApprovals ? 0 : 1);
    expect(
      order([chattedRecently, askedEarly, finishedRecently, askedLate], "status", {
        statusRank: rank,
      }),
    ).toEqual(["asked-late", "asked-early", "finished-recently", "chatted-recently"]);
  });
});

describe("createInboxChangeTracker", () => {
  const finishedRecently = thread("finished-recently", {
    latestRun: run("2026-06-01T10:00:00.000Z", "2026-06-01T11:30:00.000Z"),
  });
  const sleeper = thread("sleeper", {
    snoozedUntil: "2026-06-01T15:00:00.000Z",
    snoozedAt: "2026-06-01T08:00:00.000Z",
    latestRun: run("2026-06-01T09:00:00.000Z", "2026-06-01T09:30:00.000Z"),
  });
  const awakened = { ...sleeper, snoozedUntil: null, snoozedAt: null };
  // Snoozed at 10:00, after its last run failed at 09:00.
  const failedThenSnoozed = thread("sleeper", {
    ...failed("2026-06-01T08:50:00.000Z", "2026-06-01T09:00:00.000Z"),
    snoozedUntil: "2026-06-01T15:00:00.000Z",
    snoozedAt: "2026-06-01T10:00:00.000Z",
  });

  const inboxOrder = (
    tracker: ReturnType<typeof createInboxChangeTracker>,
    woken: typeof sleeper,
  ) => order([finishedRecently, woken], "last_status_change", { changedAt: tracker.changedAt });

  it("counts a manual unsnooze, which leaves no wake time on the shell", () => {
    const tracker = createInboxChangeTracker();
    tracker.observe([sleeper], "2026-06-01T11:00:00.000Z");
    tracker.observe([awakened], "2026-06-01T11:50:00.000Z");
    expect(inboxOrder(tracker, awakened)).toEqual(["sleeper", "finished-recently"]);
  });

  it("counts a manual unsnooze when the last run failed before the snooze began", () => {
    const tracker = createInboxChangeTracker();
    const unsnoozed = { ...failedThenSnoozed, snoozedUntil: null, snoozedAt: null };
    tracker.observe([failedThenSnoozed], "2026-06-01T11:00:00.000Z");
    tracker.observe([unsnoozed], "2026-06-01T11:50:00.000Z");
    expect(inboxOrder(tracker, unsnoozed)).toEqual(["sleeper", "finished-recently"]);
  });

  it("counts a thread dragged out of Snoozed from the drop, before and after the server confirms", () => {
    const tracker = createInboxChangeTracker();
    tracker.observe([sleeper], "2026-06-01T11:00:00.000Z");
    tracker.noteWake(sleeper, Date.parse("2026-06-01T11:55:00.000Z"));
    expect(inboxOrder(tracker, awakened)).toEqual(["sleeper", "finished-recently"]);

    tracker.observe([awakened], "2026-06-01T11:55:01.000Z");
    expect(inboxOrder(tracker, awakened)).toEqual(["sleeper", "finished-recently"]);
  });

  it("counts a guest message that woke a snoozed thread, with or without an older failure", () => {
    for (const asleep of [sleeper, failedThenSnoozed]) {
      const tracker = createInboxChangeTracker();
      const guestWoke = { ...asleep, pendingGuestMessageCount: 1 };
      tracker.observe([asleep], "2026-06-01T11:00:00.000Z");
      tracker.observe([guestWoke], "2026-06-01T11:40:00.000Z");
      expect(inboxOrder(tracker, guestWoke)).toEqual(["sleeper", "finished-recently"]);
    }
  });

  it("lets a failure after the snooze date its own wake", () => {
    const tracker = createInboxChangeTracker();
    const failedInSleep = {
      ...sleeper,
      ...failed("2026-06-01T10:00:00.000Z", "2026-06-01T10:30:00.000Z"),
    };
    const finishedEarly = thread("finished-early", {
      latestRun: run("2026-06-01T09:50:00.000Z", "2026-06-01T10:20:00.000Z"),
    });
    tracker.observe([sleeper], "2026-06-01T10:20:00.000Z");
    tracker.observe([failedInSleep], "2026-06-01T10:31:00.000Z");
    expect(tracker.changedAt(failedInSleep)).toBeUndefined();
    expect(order([finishedEarly, failedInSleep], "last_status_change")).toEqual([
      "sleeper",
      "finished-early",
    ]);
  });

  it.each([
    { state: "completed", running: false },
    { state: "still running", running: true },
  ])("counts a guest request appearing on a $state thread", ({ running }) => {
    const tracker = createInboxChangeTracker();
    const quiet = thread("sleeper", {
      latestRun: run("2026-06-01T09:00:00.000Z", running ? null : "2026-06-01T09:30:00.000Z"),
      ...(running ? { runtime: { status: "running", updatedAt: "2026-06-01T11:00:00.000Z" } } : {}),
    });
    const asked = { ...quiet, pendingGuestMessageCount: 1 };
    tracker.observe([quiet], "2026-06-01T11:00:00.000Z");
    tracker.observe([asked], "2026-06-01T11:45:00.000Z");
    expect(inboxOrder(tracker, asked)).toEqual(["sleeper", "finished-recently"]);
  });

  it("counts a subagent request appearing on a stopped parent", () => {
    const tracker = createInboxChangeTracker();
    const parent = thread("sleeper", {
      latestRun: run("2026-06-01T09:00:00.000Z", "2026-06-01T09:30:00.000Z"),
    });
    const asked = { ...parent, pendingSubagentRequest: "approval" as const };
    tracker.observe([parent], "2026-06-01T11:00:00.000Z");
    tracker.observe([asked], "2026-06-01T11:45:00.000Z");
    expect(inboxOrder(tracker, asked)).toEqual(["sleeper", "finished-recently"]);
  });

  it("stamps neither a first sighting nor a wake the shell dates itself", () => {
    const tracker = createInboxChangeTracker();
    const seenAwake = thread("seen-awake");
    const alreadyAsking = thread("already-asking", { pendingGuestMessageCount: 1 });
    const scheduled = thread("scheduled", {
      snoozedUntil: "2026-06-01T12:30:00.000Z",
      snoozedAt: "2026-06-01T08:00:00.000Z",
    });
    const asked = thread("asked", {
      snoozedUntil: "2026-06-01T15:00:00.000Z",
      snoozedAt: "2026-06-01T08:00:00.000Z",
    });
    tracker.observe([seenAwake, alreadyAsking, scheduled, asked], now);
    tracker.observe(
      [
        seenAwake,
        alreadyAsking,
        scheduled,
        { ...asked, ...asking("approval", "2026-06-01T12:10:00.000Z") },
      ],
      "2026-06-01T12:31:00.000Z",
    );
    for (const untouched of [seenAwake, alreadyAsking, scheduled, asked]) {
      expect(tracker.changedAt(untouched)).toBeUndefined();
    }
  });

  it("keeps what it dated across a reload and across switching the order off", () => {
    const { store } = memoryStore();
    const tracker = createInboxChangeTracker({ store });
    tracker.observe([sleeper], "2026-06-01T11:00:00.000Z");
    tracker.observe([awakened], "2026-06-01T11:50:00.000Z");
    tracker.observe(null, "2026-06-01T11:55:00.000Z");

    for (const kept of [tracker, createInboxChangeTracker({ store })]) {
      expect(inboxOrder(kept, awakened)).toEqual(["sleeper", "finished-recently"]);
    }
  });

  it("keeps a bounded history", () => {
    const { store, saved } = memoryStore();
    const tracker = createInboxChangeTracker({
      store,
      maxEntries: 3,
      maxAgeMs: 24 * 60 * 60 * 1_000,
    });
    const wake = (id: string, at: string) => tracker.noteWake(thread(id), Date.parse(at));
    const kept = () => Object.keys(saved()).sort();

    wake("ancient", "2026-05-29T12:00:00.000Z");
    wake("a", "2026-06-01T09:00:00.000Z");
    expect(kept()).toEqual(["environment-1:a"]);

    wake("b", "2026-06-01T10:00:00.000Z");
    wake("c", "2026-06-01T11:00:00.000Z");
    expect(kept()).toEqual(["environment-1:a", "environment-1:b", "environment-1:c"]);

    wake("d", "2026-06-01T11:30:00.000Z");
    expect(kept()).toEqual(["environment-1:b", "environment-1:c", "environment-1:d"]);
  });
});
