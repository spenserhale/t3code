import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Start a new thread on another provider that carries on from an existing one. */
export const threadContinueInProvider = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread:continue-in-provider",
  tag: WS_METHODS.threadContinueInProvider,
});
