import { EnvironmentId, ThreadId, ThreadWaitError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  listThreadWaitBlockerCandidates,
  threadWaitErrorMessage,
  threadWaitLabel,
} from "./threadWait.logic";

const env = EnvironmentId.make("env");
const other = EnvironmentId.make("other");

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    environmentId: env,
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    projectId: "project",
    updatedAt: "2026-11-07T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null, sideChat: false },
    ...overrides,
  } as unknown as Parameters<typeof listThreadWaitBlockerCandidates>[0]["threads"][number];
}

describe("listThreadWaitBlockerCandidates", () => {
  const waiting = { environmentId: env, id: ThreadId.make("a") };
  const list = (
    threads: ReturnType<typeof thread>[],
    options: { query?: string; waits?: { threadId: ThreadId; blockerThreadId: ThreadId }[] } = {},
  ) =>
    listThreadWaitBlockerCandidates({
      threads,
      waiting,
      waits: options.waits ?? [],
      query: options.query ?? "",
      projectTitle: () => "Library",
    }).map((candidate) => candidate.id);

  it("offers only open, listed threads of the same environment, newest first", () => {
    expect(
      list([
        thread("a"),
        thread("old", { updatedAt: "2026-11-01T00:00:00Z" }),
        thread("new", { updatedAt: "2026-11-08T00:00:00Z" }),
        thread("settled", { settledOverride: "settled" }),
        thread("archived", { archivedAt: "2026-11-06T00:00:00Z" }),
        thread("remote", { environmentId: other }),
        thread("subagent", { lineage: { relationshipToParent: "subagent", sideChat: false } }),
        thread("side", { lineage: { relationshipToParent: null, sideChat: true } }),
      ]),
    ).toEqual(["new", "old"]);
  });

  it("drops threads that already wait on the waiting thread, directly or through a chain", () => {
    const waits = [
      { threadId: ThreadId.make("b"), blockerThreadId: ThreadId.make("a") },
      { threadId: ThreadId.make("c"), blockerThreadId: ThreadId.make("b") },
    ];
    expect(list([thread("b"), thread("c"), thread("d")], { waits })).toEqual(["d"]);
  });

  it("matches the query against title and project", () => {
    expect(list([thread("x", { title: "Fix parser" }), thread("y")], { query: "parser" })).toEqual([
      "x",
    ]);
    expect(list([thread("x")], { query: "libr" })).toEqual(["x"]);
  });
});

describe("thread wait text", () => {
  it("names the blocker, or a thread when it is unknown", () => {
    expect(threadWaitLabel("Fix parser")).toBe("Waiting on Fix parser");
    expect(threadWaitLabel(null)).toBe("Waiting on a thread");
    expect(threadWaitLabel("  ")).toBe("Waiting on a thread");
  });

  it("explains server refusals", () => {
    expect(threadWaitErrorMessage(new ThreadWaitError({ reason: "cycle", message: "raw" }))).toBe(
      "That thread already waits on this one.",
    );
    expect(threadWaitErrorMessage(new Error("socket closed"))).toBe("socket closed");
  });
});
