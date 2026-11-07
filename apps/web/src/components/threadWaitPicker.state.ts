import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

type Request = {
  readonly threadRef: ScopedThreadRef;
  readonly resolve: (blockerThreadId: ThreadId | null) => void;
};

export const useThreadWaitPickerRequest = create<{ request: Request | null }>(() => ({
  request: null,
}));

/** Opens the "Until thread…" picker for `threadRef`; resolves null when dismissed. */
export function requestThreadWaitBlocker(threadRef: ScopedThreadRef): Promise<ThreadId | null> {
  useThreadWaitPickerRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useThreadWaitPickerRequest.setState({ request: { threadRef, resolve } }),
  );
}

export function finishThreadWaitPicker(blockerThreadId: ThreadId | null) {
  const request = useThreadWaitPickerRequest.getState().request;
  useThreadWaitPickerRequest.setState({ request: null });
  request?.resolve(blockerThreadId);
}
