import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, onTestFinished } from "vite-plus/test";

import {
  DraftId,
  resolveDraftPromotionNavigationTarget,
  restoreFailedDraftThread,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  pruneExpiredMachineHandoffs,
  type PendingMachineHandoff,
  useThreadMachineHandoffStore,
} from "../threadMachineHandoffStore";
import {
  startMachineHandoffSettling,
  type HandoffSettleOutcome,
} from "./threadMachineHandoffSettle";

type Shell = NonNullable<
  Parameters<typeof resolveDraftPromotionNavigationTarget>[0]["serverThread"]
>;

const sourceEnvironment = EnvironmentId.make("environment-source");
const targetEnvironment = EnvironmentId.make("environment-target");
const draftId = DraftId.make("draft-handoff");
const reservedThread = scopeThreadRef(targetEnvironment, ThreadId.make("thread-reserved"));
const projectRef = scopeProjectRef(targetEnvironment, ProjectId.make("project-target"));

const note = 'Continuing "Fix the flaky login test", handed off from Laptop.';
const attachmentId = "attachment-conversation";
const pending: PendingMachineHandoff = {
  source: scopeThreadRef(sourceEnvironment, ThreadId.make("thread-source")),
  title: "Fix the flaky login test",
  sourceLabel: "Laptop",
  targetLabel: "Server",
  target: reservedThread,
  noteMarker: note,
  attachmentId,
  createdAt: "2026-11-02T00:00:00.000Z",
};

const starting: Shell = {
  latestRun: {
    runId: RunId.make("run-1"),
    status: "preparing",
    requestedAt: "2026-11-02T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
  },
  latestUserMessageAt: null,
};
const sent: Shell = { ...starting, latestUserMessageAt: "2026-11-02T00:00:01.000Z" };

function harness(outcomes: Array<HandoffSettleOutcome | Error> = []) {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  onTestFinished(() => registry.dispose());
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const threadRefsAtom = Atom.make<ReadonlyArray<ScopedThreadRef>>([]).pipe(Atom.keepAlive);
  const connectedAtom = Atom.make<ReadonlyArray<EnvironmentId>>([
    sourceEnvironment,
    targetEnvironment,
  ]);
  const shellAtoms = new Map<string, Atom.Writable<Shell | null>>();
  const shellAtom = (ref: ScopedThreadRef) => {
    const key = scopedThreadKey(ref);
    let atom = shellAtoms.get(key);
    if (!atom) {
      atom = Atom.make<Shell | null>(null).pipe(Atom.keepAlive);
      shellAtoms.set(key, atom);
    }
    return atom;
  };
  const settled: Array<PendingMachineHandoff> = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  const checks = new Set<() => void>();
  const clock = { now: 0 };
  onTestFinished(
    startMachineHandoffSettling({
      registry,
      threadRefsAtom,
      connectedEnvironmentIdsAtom: connectedAtom,
      threadShellAtom: shellAtom,
      settle: async (entry) => {
        settled.push(entry);
        const outcome = outcomes.shift() ?? "settled";
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      now: () => clock.now,
      schedule: (run, ms) => {
        timers.push({ run, ms });
        return () => {};
      },
      settleDown: (run) => {
        checks.add(run);
        return () => checks.delete(run);
      },
    }),
  );
  flush();
  return {
    settled,
    timers,
    clock,
    /** Lets the drafts' state rest, which is when a handoff is judged to have been left. */
    rest() {
      for (const run of Array.from(checks)) {
        checks.delete(run);
        run();
      }
    },
    /** Lets the settle calls that are running finish, then what they set off. */
    async settleCalls() {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      flush();
    },
    flush,
    arrive(ref: ScopedThreadRef, shell: Shell | null = null) {
      registry.set(shellAtom(ref), shell);
      registry.set(threadRefsAtom, [...registry.get(threadRefsAtom), ref]);
      flush();
    },
    connect(environmentIds: ReadonlyArray<EnvironmentId>) {
      registry.set(connectedAtom, environmentIds);
      flush();
    },
    update(ref: ScopedThreadRef, shell: Shell) {
      registry.set(shellAtom(ref), shell);
      flush();
    },
  };
}

describe("settling the source of a machine handoff", () => {
  beforeEach(() => {
    useThreadMachineHandoffStore.setState({ byDraftId: {} });
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      backgroundSubmissionThreadKeys: {},
      promotedDraftRedirects: {},
    });
  });

  it("settles the source once the first message is on the server, and only once", async () => {
    const h = harness();
    openHandoff();
    h.flush();
    expect(h.settled).toEqual([]);

    h.arrive(reservedThread, starting);
    expect(h.settled).toEqual([]);

    h.update(reservedThread, sent);
    h.update(reservedThread, { ...sent, latestUserMessageAt: "2026-11-02T00:00:02.000Z" });
    expect(h.settled).toEqual([pending]);
    await h.settleCalls();
    expect(useThreadMachineHandoffStore.getState().byDraftId).toEqual({});
    h.update(reservedThread, { ...sent, latestUserMessageAt: "2026-11-02T00:00:03.000Z" });
    expect(h.settled).toEqual([pending]);
  });

  it("waits for the source's machine to be connected", () => {
    const h = harness();
    openHandoff();
    h.connect([targetEnvironment]);
    h.arrive(reservedThread, sent);
    expect(h.settled).toEqual([]);
    expect(useThreadMachineHandoffStore.getState().byDraftId).toEqual({ [draftId]: pending });

    h.connect([sourceEnvironment, targetEnvironment]);
    expect(h.settled).toEqual([pending]);
  });

  it("leaves the source alone while the draft is unsent", () => {
    const h = harness();
    openHandoff();
    h.flush();
    expect(h.settled).toEqual([]);
    expect(useThreadMachineHandoffStore.getState().byDraftId).toEqual({ [draftId]: pending });
  });

  it("follows a draft restored under a new thread id after a failed send", () => {
    const h = harness();
    openHandoff();
    const draft = useComposerDraftStore.getState().getDraftSession(draftId)!;
    const retried = scopeThreadRef(targetEnvironment, ThreadId.make("thread-retried"));
    restoreFailedDraftThread(draftId, draft, retried.threadId);
    h.flush();

    h.arrive(reservedThread, starting);
    expect(h.settled).toEqual([]);

    h.arrive(retried, sent);
    expect(h.settled).toEqual([{ ...pending, target: retried }]);
  });

  it("settles after the draft is gone, through the thread it was promoted to", () => {
    const h = harness();
    useThreadMachineHandoffStore.getState().remember(draftId, pending);
    h.flush();
    h.arrive(reservedThread, sent);
    expect(h.settled).toEqual([pending]);
  });

  it("settles through the redirect recorded when a draft was finalized", () => {
    const h = harness();
    const promoted = scopeThreadRef(targetEnvironment, ThreadId.make("thread-promoted"));
    useComposerDraftStore.setState({ promotedDraftRedirects: { [draftId]: promoted } });
    useThreadMachineHandoffStore.getState().remember(draftId, pending);
    h.arrive(reservedThread, sent);
    expect(h.settled).toEqual([]);
    h.arrive(promoted, sent);
    expect(h.settled).toEqual([pending]);
  });
});

/** A draft as the handoff leaves it: the note as the prompt, the conversation attached. */
function openHandoff(entry: PendingMachineHandoff = pending) {
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(projectRef, draftId, { threadId: reservedThread.threadId });
  drafts.setPrompt(draftId, `${note}\n\n`);
  drafts.addFiles(draftId, [
    {
      type: "file",
      id: attachmentId,
      name: "thread.jsonl",
      mimeType: "application/x-ndjson",
      sizeBytes: 2,
      file: new File(["{}"], "thread.jsonl"),
    },
  ]);
  useThreadMachineHandoffStore.getState().remember(draftId, entry);
}

const remembered = () => useThreadMachineHandoffStore.getState().byDraftId[draftId];

describe("a settle that does not succeed", () => {
  beforeEach(() => {
    useThreadMachineHandoffStore.setState({ byDraftId: {}, sending: {} });
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      backgroundSubmissionThreadKeys: {},
      promotedDraftRedirects: {},
    });
  });

  it.each([
    ["is refused for now", "retry" as const],
    ["fails with an error", new Error("disconnected")],
  ])("keeps the handoff and tries again later when it %s", async (_name, outcome) => {
    const h = harness([outcome, "settled"]);
    openHandoff();
    h.arrive(reservedThread, sent);
    await h.settleCalls();
    expect(h.settled).toHaveLength(1);
    expect(remembered()).toBeDefined();
    expect(h.timers.map((timer) => timer.ms)).toEqual([5_000]);

    h.clock.now = 5_000;
    h.timers[0]!.run();
    h.flush();
    await h.settleCalls();
    expect(h.settled).toHaveLength(2);
    expect(remembered()).toBeUndefined();
  });

  it("waits longer after each failure, and does not try early when something else changes", async () => {
    const h = harness(["retry", "retry", "settled"]);
    openHandoff();
    h.arrive(reservedThread, sent);
    await h.settleCalls();
    h.update(reservedThread, { ...sent, latestUserMessageAt: "2026-11-02T00:00:02.000Z" });
    await h.settleCalls();
    expect(h.settled).toHaveLength(1);

    h.clock.now = 5_000;
    h.timers[0]!.run();
    h.flush();
    await h.settleCalls();
    expect(h.settled).toHaveLength(2);
    expect(h.timers.map((timer) => timer.ms)).toEqual([5_000, 15_000]);
  });

  it("lets go of a handoff whose source thread is gone", async () => {
    const h = harness(["gone"]);
    openHandoff();
    h.arrive(reservedThread, sent);
    await h.settleCalls();
    expect(remembered()).toBeUndefined();
    expect(h.timers).toEqual([]);
  });

  it("still has the handoff after a reload, until it has been settled", async () => {
    const first = harness(["retry"]);
    openHandoff();
    first.arrive(reservedThread, sent);
    await first.settleCalls();
    expect(remembered()).toBeDefined();
  });
});

describe("a draft that stops being the handoff", () => {
  beforeEach(() => {
    useThreadMachineHandoffStore.setState({ byDraftId: {}, sending: {} });
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      backgroundSubmissionThreadKeys: {},
      promotedDraftRedirects: {},
    });
  });

  it("is let go when the draft is discarded", () => {
    const h = harness();
    openHandoff();
    h.rest();
    expect(remembered()).toBeDefined();
    useComposerDraftStore.getState().clearDraftThread(draftId);
    h.rest();
    expect(remembered()).toBeUndefined();
    h.arrive(reservedThread, sent);
    expect(h.settled).toEqual([]);
  });

  it("is let go when the note and the conversation are both taken out", () => {
    const h = harness();
    openHandoff();
    h.rest();
    useComposerDraftStore.getState().setPrompt(draftId, "Something else entirely");
    h.rest();
    expect(remembered()).toBeDefined();
    useComposerDraftStore.getState().removeFile(draftId, attachmentId);
    h.rest();
    expect(remembered()).toBeUndefined();
  });

  it("stays when only the note, or only the conversation, is taken out", () => {
    const h = harness();
    openHandoff();
    useComposerDraftStore.getState().setPrompt(draftId, "My own instructions");
    h.rest();
    expect(remembered()).toBeDefined();
    useComposerDraftStore.getState().setPrompt(draftId, `${note}\n\n`);
    useComposerDraftStore.getState().removeFile(draftId, attachmentId);
    h.rest();
    expect(remembered()).toBeDefined();
  });

  it("stays through a send that fails and is restored, and while one is under way", () => {
    const h = harness();
    openHandoff();
    h.rest();
    const drafts = useComposerDraftStore.getState();
    const draft = drafts.getDraftSession(draftId)!;
    // The send marks the draft as promoting and clears the composer, then a failure restores both.
    drafts.markDraftThreadPromoting(draftId);
    drafts.clearComposerContent(draftId);
    h.rest();
    expect(remembered()).toBeDefined();
    restoreFailedDraftThread(draftId, draft, ThreadId.make("thread-retried"));
    drafts.setPrompt(draftId, `${note}\n\n`);
    h.rest();
    expect(remembered()).toBeDefined();
  });

  it("stays while a fan-out send has cleared the composer", () => {
    const h = harness();
    openHandoff();
    h.rest();
    useThreadMachineHandoffStore.getState().beginSend(draftId);
    useComposerDraftStore.getState().clearComposerContent(draftId);
    h.rest();
    expect(remembered()).toBeDefined();
    useThreadMachineHandoffStore.getState().endSend(draftId);
    useComposerDraftStore.getState().setPrompt(draftId, `${note}\n\n`);
    h.rest();
    expect(remembered()).toBeDefined();
  });

  it("is not let go just because the draft is not there after a reload", () => {
    const h = harness();
    useThreadMachineHandoffStore.getState().remember(draftId, pending);
    h.rest();
    expect(remembered()).toBeDefined();
  });
});

describe("the thread a handoff follows", () => {
  beforeEach(() => {
    useThreadMachineHandoffStore.setState({ byDraftId: {}, sending: {} });
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      backgroundSubmissionThreadKeys: {},
      promotedDraftRedirects: {},
    });
  });

  it("is saved when a failed send gives the draft a new thread id, for after the draft is gone", () => {
    const h = harness();
    openHandoff();
    const retried = scopeThreadRef(targetEnvironment, ThreadId.make("thread-retried"));
    restoreFailedDraftThread(
      draftId,
      useComposerDraftStore.getState().getDraftSession(draftId)!,
      retried.threadId,
    );
    h.flush();
    expect(remembered()?.target).toEqual(retried);

    // Finalized, then the page reloaded: no draft and no redirect, only what was saved.
    useComposerDraftStore.setState({ draftThreadsByThreadKey: {}, promotedDraftRedirects: {} });
    h.arrive(retried, sent);
    expect(h.settled.map((entry) => entry.target)).toEqual([retried]);
  });

  it("is the first fan-out child that was started, not the draft's own thread", () => {
    const h = harness();
    openHandoff();
    const child = scopeThreadRef(targetEnvironment, ThreadId.make("thread-child"));
    useThreadMachineHandoffStore.getState().retarget(draftId, { sentAs: child });
    h.flush();
    h.arrive(reservedThread, sent);
    expect(h.settled).toEqual([]);
    h.arrive(child, sent);
    expect(h.settled).toHaveLength(1);
  });
});

describe("pruneExpiredMachineHandoffs", () => {
  it("drops entries older than 30 days and keeps the rest", () => {
    const now = Date.parse("2026-12-15T00:00:00.000Z");
    const kept = { ...pending, createdAt: "2026-12-01T00:00:00.000Z" };
    const unreadable = { ...pending, createdAt: "not a date" };
    expect(pruneExpiredMachineHandoffs({ old: pending, kept, unreadable }, now)).toEqual({
      kept,
      unreadable,
    });
  });
});
