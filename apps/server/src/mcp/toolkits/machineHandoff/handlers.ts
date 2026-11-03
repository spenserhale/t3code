import * as Effect from "effect/Effect";

import * as ThreadMachineHandoff from "../../../peer/ThreadMachineHandoff.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorktreeOpenBranch from "../../WorktreeOpenBranch.ts";
import { MachineHandoffToolkit } from "./tools.ts";

const handlers = {
  t3_thread_continue_on_machine: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMachineHandoff.ThreadMachineHandoff;
        return yield* service.continueOnMachine(scope, input);
      }),
  ),
  // A branch on a worktree here belongs to no thread until a launch binds it, so a link may open
  // the one its own thread is about to use.
  t3_worktree_open_branch: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* WorktreeOpenBranch.WorktreeOpenBranch;
        return yield* service.open(scope, input);
      }),
    { linkedCallers: "allowed" },
  ),
} satisfies McpToolAccess.Handlers<typeof MachineHandoffToolkit.tools>;

export const layer = McpToolAccess.toLayer(MachineHandoffToolkit, handlers);
