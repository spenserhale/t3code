import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/** A thread handed to another machine, waiting for the first message sent there. */
export interface PendingMachineHandoff {
  readonly source: ScopedThreadRef;
  readonly title: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  /** The thread the draft will become, in case the draft is gone when it is checked. */
  readonly target: ScopedThreadRef;
  readonly createdAt: string;
}

interface ThreadMachineHandoffStoreState {
  byDraftId: Record<string, PendingMachineHandoff>;
  remember: (draftId: string, pending: PendingMachineHandoff) => void;
  forget: (draftId: string) => void;
}

/** A draft never sent leaves its entry behind; nothing else reads it, so it only needs to age out. */
const PENDING_HANDOFF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function pruneExpiredMachineHandoffs(
  byDraftId: Readonly<Record<string, PendingMachineHandoff>>,
  now: number,
): Record<string, PendingMachineHandoff> {
  return Object.fromEntries(
    Object.entries(byDraftId).filter(([, pending]) => {
      const age = now - Date.parse(pending.createdAt);
      return !Number.isFinite(age) || age < PENDING_HANDOFF_MAX_AGE_MS;
    }),
  );
}

const STORAGE_KEY = "t3code:thread-machine-handoff:v1";

export const useThreadMachineHandoffStore = create<ThreadMachineHandoffStoreState>()(
  persist(
    (set) => ({
      byDraftId: {},
      remember: (draftId, pending) =>
        set((state) => ({ byDraftId: { ...state.byDraftId, [draftId]: pending } })),
      forget: (draftId) =>
        set((state) => {
          if (!(draftId in state.byDraftId)) return state;
          const { [draftId]: _forgotten, ...byDraftId } = state.byDraftId;
          return { byDraftId };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byDraftId: state.byDraftId }),
      merge: (persisted, current) => {
        const stored = (persisted as { byDraftId?: unknown } | null)?.byDraftId;
        return {
          ...current,
          byDraftId:
            stored !== null && typeof stored === "object"
              ? pruneExpiredMachineHandoffs(
                  stored as Record<string, PendingMachineHandoff>,
                  Date.now(),
                )
              : {},
        };
      },
    },
  ),
);

// Another tab of this profile writes the whole map; without this, a stale tab would bring back an
// entry that was already settled.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) void useThreadMachineHandoffStore.persist.rehydrate();
  });
}
