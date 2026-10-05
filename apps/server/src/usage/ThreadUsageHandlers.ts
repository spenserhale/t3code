/**
 * ThreadUsageHandlers - the `server.getThreadUsage` and `server.listThreadUsage`
 * WebSocket handlers, spread into the handlers `ws.ts` serves.
 *
 * The service is optional: a runtime or suite that does not provide it still
 * answers both requests, with no usage, and needs nothing added to its layer.
 *
 * @module ThreadUsageHandlers
 */
import { WS_METHODS, type ThreadUsageInput, type UsageSummaryInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadUsage from "./ThreadUsage.ts";

export const make = Effect.gen(function* () {
  const threadUsage = yield* Effect.serviceOption(ThreadUsage.ThreadUsage);
  return {
    [WS_METHODS.serverGetThreadUsage]: (input: ThreadUsageInput) =>
      Option.match(threadUsage, {
        onNone: () => Effect.succeed({ threadId: input.threadId, turns: [] }),
        onSome: (service) => service.readThreadUsage(input),
      }),
    [WS_METHODS.serverListThreadUsage]: (input: UsageSummaryInput) =>
      Option.match(threadUsage, {
        onNone: () => Effect.succeed({ threads: [] }),
        onSome: (service) => service.listThreadUsage(input),
      }),
  };
});
