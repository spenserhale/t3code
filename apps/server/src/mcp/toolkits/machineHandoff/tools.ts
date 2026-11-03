import {
  OrchestratorMcpFailure,
  ThreadContinueOnMachineInput,
  ThreadContinueOnMachineResult,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMachineHandoff from "../../../peer/ThreadMachineHandoff.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WorktreeOpenBranchTool } from "./openBranchTool.ts";

const ThreadContinueOnMachineTool = Tool.make("t3_thread_continue_on_machine", {
  description:
    "Continue a thread on another linked machine (`environmentId`, from `t3_environment_links`), with its code: commits uncommitted changes as a WIP commit, pushes the branch (a new `handoff/` branch from the default branch), opens it in a worktree there, and launches a thread with the conversation attached. `message`: instructions for its agent. `projectId`: default the one with this repository; needed without a git remote, when only the conversation goes. `modelSelection`: default this thread's, else one from `orchestrator_capabilities` with that `environmentId`. Omit `threadId` for this thread; it settles when its turn ends, so end your turn after success. Retry an error or lost reply with the same `clientRequestId`.",
  parameters: ThreadContinueOnMachineInput,
  success: ThreadContinueOnMachineResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadMachineHandoff.ThreadMachineHandoff,
  ],
})
  .annotate(Tool.Title, "Continue a thread on another machine")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileLinksOff);

export const MachineHandoffToolkit = Toolkit.make(
  ThreadContinueOnMachineTool,
  WorktreeOpenBranchTool,
);
