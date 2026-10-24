import { assert, it } from "@effect/vitest";
import { ThreadId, UsageDay, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadUsageHandlers from "./ThreadUsageHandlers.ts";

it.effect("answers with no usage when the runtime has no thread usage service", () =>
  Effect.gen(function* () {
    const handlers = yield* ThreadUsageHandlers.make;
    const threadId = ThreadId.make("thread-1");

    assert.deepStrictEqual(yield* handlers[WS_METHODS.serverGetThreadUsage]({ threadId }), {
      threadId,
      turns: [],
    });
    assert.deepStrictEqual(
      yield* handlers[WS_METHODS.serverListThreadUsage]({
        sinceDay: UsageDay.make("2026-10-01"),
        untilDay: UsageDay.make("2026-10-01"),
        timeZone: "UTC",
      }),
      { threads: [] },
    );
  }),
);
