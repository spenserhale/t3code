import {
  OrchestratorMcpFailure,
  ThreadLaunchLookupInput,
  ThreadLaunchLookupResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Apart from the toolkit for the same reason as `WorktreeOpenBranchTool`. */
export const ThreadLaunchLookupTool = Tool.make("t3_thread_launch_lookup", {
  description:
    "The thread a `t3_thread_launch` with this `clientRequestId` started, or null if it started none. Read-only. After a lost reply, check it before launching again.",
  parameters: ThreadLaunchLookupInput,
  success: ThreadLaunchLookupResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Look up a launched thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
