import { ThreadId, type ThreadWait } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { blockingCount, indexThreadWaits, waitingOn, wouldCreateCycle } from "./threadWaits.ts";

const [A, B, C, D] = ["a", "b", "c", "d"].map((id) => ThreadId.make(id)) as [
  ThreadId,
  ThreadId,
  ThreadId,
  ThreadId,
];
const wait = (threadId: ThreadId, blockerThreadId: ThreadId): ThreadWait => ({
  threadId,
  blockerThreadId,
  snoozedUntil: "2027-11-07T00:00:00.000Z",
  createdAt: "2026-11-07T00:00:00.000Z",
});
// A waits on B, B waits on C, D waits on B.
const waits = [wait(A, B), wait(B, C), wait(D, B)];

describe("thread waits", () => {
  it("refuses picks that close a loop, directly or through a chain", () => {
    expect(wouldCreateCycle(waits, C, A)).toBe(true);
    expect(wouldCreateCycle(waits, C, B)).toBe(true);
    expect(wouldCreateCycle(waits, A, A)).toBe(true);
    expect(wouldCreateCycle(waits, C, D)).toBe(true);
    expect(wouldCreateCycle(waits, A, D)).toBe(false);
    expect(wouldCreateCycle(waits, A, ThreadId.make("e"))).toBe(false);
  });

  it("selects what a thread waits on and how many it blocks", () => {
    const index = indexThreadWaits(waits);
    for (const threadId of [A, B, C, D]) {
      expect(index.waitingOn(threadId)).toEqual(waitingOn(waits, threadId));
      expect(index.blockingCount(threadId)).toBe(blockingCount(waits, threadId));
    }
    expect(index.waitingOn(A)?.blockerThreadId).toBe(B);
    expect(index.waitingOn(C)).toBeNull();
    expect(index.blockingCount(B)).toBe(2);
    expect(index.blockingCount(A)).toBe(0);
  });
});
