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

/**
 * Settles the source of each handed-off thread once the first message of its new thread is on
 * the server and the source's machine is connected, wherever the user is by then. The draft's own
 * send path is not involved.
 */
export function startMachineHandoffSettling(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<SentShell | null>;
  readonly settle: (pending: PendingMachineHandoff) => Promise<unknown>;
}): () => void {
  const handoffs = useThreadMachineHandoffStore;
  const drafts = useComposerDraftStore;
  const draftSlice = (state: ReturnType<typeof drafts.getState>) => ({
    draftThreadsByThreadKey: state.draftThreadsByThreadKey,
    promotedDraftRedirects: state.promotedDraftRedirects,
  });
  const handoffsAtom = Atom.make(handoffs.getState().byDraftId);
  const draftsAtom = Atom.make(draftSlice(drafts.getState()));
  const unsubscribeHandoffs = handoffs.subscribe((state, previous) => {
    if (state.byDraftId !== previous.byDraftId) input.registry.set(handoffsAtom, state.byDraftId);
  });
  // Prompt edits replace the draft state on every keystroke; only these two slices matter here.
  const unsubscribeDrafts = drafts.subscribe((state, previous) => {
    if (
      state.draftThreadsByThreadKey !== previous.draftThreadsByThreadKey ||
      state.promotedDraftRedirects !== previous.promotedDraftRedirects
    ) {
      input.registry.set(draftsAtom, draftSlice(state));
    }
  });
  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const sentAtom = Atom.make((get) => {
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
  const settling = new Set<string>();
  const unsubscribeSent = input.registry.subscribe(
    sentAtom,
    (sent) => {
      for (const [draftId, entry] of sent) {
        if (settling.has(draftId)) continue;
        settling.add(draftId);
        handoffs.getState().forget(draftId);
        void input.settle(entry).finally(() => settling.delete(draftId));
      }
    },
    { immediate: true },
  );
  return () => {
    unsubscribeSent();
    unsubscribeDrafts();
    unsubscribeHandoffs();
  };
}
