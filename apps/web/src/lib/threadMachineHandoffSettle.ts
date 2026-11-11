import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  resolveDraftPromotionNavigationTarget,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  type PendingMachineHandoff,
  useThreadMachineHandoffStore,
} from "../threadMachineHandoffStore";

type SentShell = NonNullable<
  Parameters<typeof resolveDraftPromotionNavigationTarget>[0]["serverThread"]
>;

/** `retry` keeps the handoff for later; the other two end it. */
export type HandoffSettleOutcome = "settled" | "gone" | "retry";

/** After each failure, so a source that is busy or away is tried again without being hammered. */
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];
const MAX_ATTEMPTS = 8;
const ABANDONED_CHECK_DELAY_MS = 250;

/**
 * Settles the source of each handed-off thread once the first message of its new thread is on
 * the server and the source's machine is connected, wherever the user is by then. The draft's own
 * send path is not involved. A handoff is dropped only once settled (or when the draft stops being
 * the handoff); a failure keeps it for another try, also after a reload.
 */
export function startMachineHandoffSettling(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<SentShell | null>;
  readonly settle: (pending: PendingMachineHandoff) => Promise<HandoffSettleOutcome>;
  readonly now?: () => number;
  /** Runs a callback later and returns the way to cancel it. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  /** Like `schedule`, for the short wait before a draft is judged. */
  readonly settleDown?: (run: () => void) => () => void;
}): () => void {
  const now = input.now ?? Date.now;
  const schedule =
    input.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  const settleDown =
    input.settleDown ?? ((run: () => void) => schedule(run, ABANDONED_CHECK_DELAY_MS));
  const handoffs = useThreadMachineHandoffStore;
  const drafts = useComposerDraftStore;
  const draftSlice = (state: ReturnType<typeof drafts.getState>) => ({
    draftThreadsByThreadKey: state.draftThreadsByThreadKey,
    promotedDraftRedirects: state.promotedDraftRedirects,
  });
  const handoffsAtom = Atom.make(handoffs.getState().byDraftId);
  const draftsAtom = Atom.make(draftSlice(drafts.getState()));
  const retryTickAtom = Atom.make(0);

  // What this session has seen of each handoff's draft: a draft that was there and then is gone
  // without a send was discarded, while one that was never there only has not been loaded yet.
  const seenLive = new Set<string>();
  const seenPromoting = new Set<string>();
  const scan = () => {
    const { byDraftId } = handoffs.getState();
    const { draftThreadsByThreadKey } = drafts.getState();
    for (const [draftId, entry] of Object.entries(byDraftId)) {
      const draft = draftThreadsByThreadKey[draftId];
      if (draft === undefined) continue;
      seenLive.add(draftId);
      // Only while it is sending: a failed send restores the draft, and it is then free to be
      // used for something else.
      if (draft.promotedTo) seenPromoting.add(draftId);
      else seenPromoting.delete(draftId);
      if (entry.sentAs !== undefined) continue;
      // A failed send can give the draft a new thread id; keep the saved one in step with it.
      const current = draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId);
      if (scopedThreadKey(current) !== scopedThreadKey(entry.target)) {
        handoffs.getState().retarget(draftId, { target: current });
      }
    }
  };

  // A send clears the composer and a failed one restores it a moment later, so whether a draft
  // stopped being the handoff is decided once its state has been still for a while.
  let cancelCheck: (() => void) | null = null;
  const checkAbandoned = () => {
    cancelCheck = null;
    const { byDraftId, sending } = handoffs.getState();
    const { draftThreadsByThreadKey, promotedDraftRedirects, draftsByThreadKey } =
      drafts.getState();
    for (const [draftId, entry] of Object.entries(byDraftId)) {
      if (
        sending[draftId] === true ||
        entry.sentAs !== undefined ||
        seenPromoting.has(draftId) ||
        promotedDraftRedirects[draftId] !== undefined
      ) {
        continue;
      }
      const draft = draftThreadsByThreadKey[draftId];
      if (draft === undefined) {
        if (seenLive.has(draftId)) handoffs.getState().forget(draftId);
        continue;
      }
      if (draft.promotedTo) continue;
      // Cleared of both what the handoff put in it: the draft is being used for something else.
      const content = draftsByThreadKey[draftId];
      const hasNote =
        entry.noteMarker === undefined ||
        entry.noteMarker === "" ||
        (content?.prompt ?? "").includes(entry.noteMarker);
      const hasConversation =
        entry.attachmentId != null &&
        (content?.files ?? []).some((file) => file.id === entry.attachmentId);
      if (!hasNote && !hasConversation) handoffs.getState().forget(draftId);
    }
  };
  const queueCheck = () => {
    if (Object.keys(handoffs.getState().byDraftId).length === 0) return;
    cancelCheck?.();
    cancelCheck = settleDown(checkAbandoned);
  };
  const unsubscribeHandoffs = handoffs.subscribe((state, previous) => {
    if (state.byDraftId === previous.byDraftId && state.sending === previous.sending) return;
    scan();
    if (state.byDraftId !== previous.byDraftId) input.registry.set(handoffsAtom, state.byDraftId);
    queueCheck();
  });
  // Prompt edits replace the draft state on every keystroke, so the promotion slices are all
  // that is passed on; the content is read only when a check runs.
  const unsubscribeDrafts = drafts.subscribe((state, previous) => {
    if (
      state.draftThreadsByThreadKey !== previous.draftThreadsByThreadKey ||
      state.promotedDraftRedirects !== previous.promotedDraftRedirects
    ) {
      scan();
      input.registry.set(draftsAtom, draftSlice(state));
    }
    if (state !== previous) queueCheck();
  });
  scan();
  queueCheck();

  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const sentAtom = Atom.make((get) => {
    get(retryTickAtom);
    const pending = get(handoffsAtom);
    const { draftThreadsByThreadKey, promotedDraftRedirects } = get(draftsAtom);
    const threadKeys = get(threadKeysAtom);
    const connected = new Set(get(input.connectedEnvironmentIdsAtom));
    const sent: Array<readonly [string, PendingMachineHandoff]> = [];
    for (const [draftId, entry] of Object.entries(pending)) {
      // A source that sleeps while the new thread starts is settled when it wakes.
      if (!connected.has(entry.source.environmentId)) continue;
      const draft = draftThreadsByThreadKey[draftId];
      const ref =
        entry.sentAs ??
        draft?.promotedTo ??
        promotedDraftRedirects[draftId] ??
        (draft === undefined ? entry.target : scopeThreadRef(draft.environmentId, draft.threadId));
      if (!threadKeys.has(scopedThreadKey(ref))) continue;
      const owned = resolveDraftPromotionNavigationTarget({
        serverThreadRef: ref,
        serverThread: get(input.threadShellAtom(ref)),
        backgroundSubmissionPending: false,
      });
      if (owned !== null) sent.push([draftId, entry]);
    }
    return sent;
  });
  const attempts = new Map<string, { count: number; notBefore: number }>();
  const settling = new Set<string>();
  const cancelTimers = new Set<() => void>();
  let tick = 0;
  const finish = (draftId: string, outcome: HandoffSettleOutcome) => {
    settling.delete(draftId);
    if (outcome !== "retry") {
      attempts.delete(draftId);
      handoffs.getState().forget(draftId);
      return;
    }
    const count = (attempts.get(draftId)?.count ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[Math.min(count, RETRY_DELAYS_MS.length) - 1] ?? 300_000;
    attempts.set(draftId, { count, notBefore: now() + delay });
    if (count < MAX_ATTEMPTS) {
      const cancel = schedule(() => {
        cancelTimers.delete(cancel);
        tick += 1;
        input.registry.set(retryTickAtom, tick);
      }, delay);
      cancelTimers.add(cancel);
    }
  };
  const unsubscribeSent = input.registry.subscribe(
    sentAtom,
    (sent) => {
      for (const [draftId, entry] of sent) {
        if (settling.has(draftId)) continue;
        const tried = attempts.get(draftId);
        if (tried !== undefined && (tried.count >= MAX_ATTEMPTS || now() < tried.notBefore)) {
          continue;
        }
        settling.add(draftId);
        void input.settle(entry).then(
          (outcome) => finish(draftId, outcome),
          () => finish(draftId, "retry"),
        );
      }
    },
    { immediate: true },
  );
  return () => {
    cancelCheck?.();
    unsubscribeSent();
    for (const cancel of cancelTimers) cancel();
    unsubscribeDrafts();
    unsubscribeHandoffs();
  };
}
