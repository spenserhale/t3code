import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as HttpClient from "effect/http/HttpClient";

import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";
import {
  combineUsageLimits,
  consumeZaiResetCredit,
  keepLastGoodUsageLimits,
  readZaiCodingPlanUsageLimits,
} from "./zaiUsageLimits.ts";

/**
 * Reads the subscriptions an OpenCode account can hold, OpenCode Go and the Z.ai Coding Plan,
 * as the account's usage limits. Build it once, where the provider is built: each subscription
 * remembers its last good read between refreshes.
 */
export const makeSubscriptionUsageLimits = Effect.fn("makeSubscriptionUsageLimits")(
  function* (input: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly serverUrl: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | Crypto.Crypto
    >();
    const readGoLimits = yield* keepLastGoodUsageLimits(readOpenCodeGoUsageLimits(input));
    const readZaiLimits = yield* keepLastGoodUsageLimits(readZaiCodingPlanUsageLimits(input));
    const usageLimits = Effect.all(
      { goLimits: readGoLimits, zaiLimits: readZaiLimits },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.flatMap(({ goLimits, zaiLimits }) => combineUsageLimits([goLimits, zaiLimits])),
      Effect.provide(services),
    );

    // Z.ai is the only OpenCode subscription that banks quota resets. `refreshSnapshot` runs after
    // a reset, because the windows just changed.
    const consumeResetCredit = (refreshSnapshot: Effect.Effect<unknown>) => () =>
      consumeZaiResetCredit(input).pipe(
        Effect.provide(services),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: input.driver,
              instanceId: input.instanceId,
              detail:
                cause._tag === "ZaiResetRejected"
                  ? cause.message
                  : "Z.ai could not redeem the quota reset.",
              cause,
            }),
        ),
        Effect.tap((outcome) => (outcome === "reset" ? refreshSnapshot : Effect.void)),
      );

    return { usageLimits, consumeResetCredit };
  },
);
