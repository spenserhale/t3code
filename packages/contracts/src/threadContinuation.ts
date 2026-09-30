import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * Continue a thread on another provider instance. The server copies the
 * source conversation into a new thread, then starts its first turn with the
 * full transcript attached so the new agent knows what was said.
 */
export const ThreadContinueInProviderInput = Schema.Struct({
  sourceThreadId: ThreadId,
  /** Client-generated, so the client can navigate before the stream catches up. */
  threadId: ThreadId,
  modelSelection: ModelSelection,
});
export type ThreadContinueInProviderInput = typeof ThreadContinueInProviderInput.Type;

export const ThreadContinueInProviderResult = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadContinueInProviderResult = typeof ThreadContinueInProviderResult.Type;

export class ThreadContinueInProviderError extends Schema.TaggedError<ThreadContinueInProviderError>()(
  "ThreadContinueInProviderError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
