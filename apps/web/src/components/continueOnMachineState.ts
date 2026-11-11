import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export interface ContinueOnMachineRequest {
  readonly threadRef: ScopedThreadRef;
  /** The machine the menu was opened on, or null to let the dialog pick one. */
  readonly targetEnvironmentId: EnvironmentId | null;
}

export const useContinueOnMachineRequest = create<{
  request: ContinueOnMachineRequest | null;
  session: number;
}>(() => ({ request: null, session: 0 }));

export function openContinueOnMachine(request: ContinueOnMachineRequest) {
  useContinueOnMachineRequest.setState((state) => ({ request, session: state.session + 1 }));
}

export function closeContinueOnMachine() {
  useContinueOnMachineRequest.setState({ request: null });
}

const CONTINUE_ON_PREFIX = "continue-on:";

/** Opens the dialog for a "Continue on" entry of the thread menu; false for any other entry. */
export function handleContinueOnMenuAction(action: string, threadRef: ScopedThreadRef): boolean {
  if (!action.startsWith(CONTINUE_ON_PREFIX)) return false;
  openContinueOnMachine({
    threadRef,
    targetEnvironmentId: EnvironmentId.make(action.slice(CONTINUE_ON_PREFIX.length)),
  });
  return true;
}
