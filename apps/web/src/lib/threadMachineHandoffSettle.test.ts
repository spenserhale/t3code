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
import { startMachineHandoffSettling } from "./threadMachineHandoffSettle";

type Shell = NonNullable<
  Parameters<typeof resolveDraftPromotionNavigationTarget>[0]["serverThread"]
>;

const sourceEnvironment = EnvironmentId.make("environment-source");
const targetEnvironment = EnvironmentId.make("environment-target");
const draftId = DraftId.make("draft-handoff");
const reservedThread = scopeThreadRef(targetEnvironment, ThreadId.make("thread-reserved"));
const projectRef = scopeProjectRef(targetEnvironment, ProjectId.make("project-target"));

const pending: PendingMachineHandoff = {
  source: scopeThreadRef(sourceEnvironment, ThreadId.make("thread-source")),
  title: "Fix the flaky login test",
  sourceLabel: "Laptop",
  targetLabel: "Server",
  target: reservedThread,
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

function harness() {
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
  onTestFinished(
    startMachineHandoffSettling({
      registry,
      threadRefsAtom,
      connectedEnvironmentIdsAtom: connectedAtom,
      threadShellAtom: shellAtom,
      settle: async (entry) => {
        settled.push(entry);
      },
    }),
  );
  flush();
  return {
    settled,
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

function openDraft() {
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(projectRef, draftId, { threadId: reservedThread.threadId });
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

  it("settles the source once the first message is on the server, and only once", () => {
    const h = harness();
    openDraft();
    useThreadMachineHandoffStore.getState().remember(draftId, pending);
    h.flush();
    expect(h.settled).toEqual([]);

    h.arrive(reservedThread, starting);
    expect(h.settled).toEqual([]);

    h.update(reservedThread, sent);
    h.update(reservedThread, { ...sent, latestUserMessageAt: "2026-11-02T00:00:02.000Z" });
    expect(h.settled).toEqual([pending]);
    expect(useThreadMachineHandoffStore.getState().byDraftId).toEqual({});
  });

  it("waits for the source's machine to be connected", () => {
    const h = harness();
    openDraft();
    useThreadMachineHandoffStore.getState().remember(draftId, pending);
    h.connect([targetEnvironment]);
    h.arrive(reservedThread, sent);
    expect(h.settled).toEqual([]);
    expect(useThreadMachineHandoffStore.getState().byDraftId).toEqual({ [draftId]: pending });

    h.connect([sourceEnvironment, targetEnvironment]);
    expect(h.settled).toEqual([pending]);
  });

  it("leaves the source alone while the draft is unsent", () => {
    const h = harness();
    openDraft();
    useThreadMachineHandoffStore.getState().remember(draftId, pending);
    h.flush();
    expect(h.settled).toEqual([]);
    expect(useThreadMachineHandoffStore.getState().byDraftId).toEqual({ [draftId]: pending });
  });

  it("follows a draft restored under a new thread id after a failed send", () => {
    const h = harness();
    openDraft();
    useThreadMachineHandoffStore.getState().remember(draftId, pending);
    const draft = useComposerDraftStore.getState().getDraftSession(draftId)!;
    const retried = scopeThreadRef(targetEnvironment, ThreadId.make("thread-retried"));
    restoreFailedDraftThread(draftId, draft, retried.threadId);
    h.flush();

    h.arrive(reservedThread, starting);
    expect(h.settled).toEqual([]);

    h.arrive(retried, sent);
    expect(h.settled).toEqual([pending]);
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
