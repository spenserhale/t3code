import type { ServerProviderUsageBalance } from "@t3tools/contracts";
import { ForwardCompatibleOptional } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { SubscriptionLimits } from "./zaiUsageLimits.ts";

const API_ORIGIN = "https://api.unlid.ai";

/** Lowercase hex SHA-256 of the UTF-8 text, the same bytes `node:crypto` produced. */
const sha256Hex = (text: string) =>
  Digest.Digest.pipe(
    Effect.flatMap((digest) => digest.digest(Digest.sha256, new TextEncoder().encode(text))),
    Effect.map(Hex.encode),
    Effect.orDie,
  );

const AuthFile = Schema.Struct({ unlid: Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);

// `balance_usd` decides support; the rest ride along when present and well-formed.
const MeResponse = Schema.Struct({
  name: ForwardCompatibleOptional(Schema.String),
  prefix: ForwardCompatibleOptional(Schema.String),
  balance_usd: Schema.Finite,
  held_usd: ForwardCompatibleOptional(Schema.Finite),
  month_spend_usd: ForwardCompatibleOptional(Schema.Finite),
});

/** The key OpenCode stored for this account, else `UNLID_API_KEY`. */
const readApiKey = Effect.fn("readUnlidApiKey")(function* (env: NodeJS.ProcessEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataHome =
    env.XDG_DATA_HOME ||
    path.join(env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory), ".local", "share");
  const contents =
    env.OPENCODE_AUTH_CONTENT ||
    (yield* fs.readFileString(path.join(dataHome, "opencode", "auth.json")).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
    ));
  const apiAuth = decodeApiAuth((yield* decodeAuthFile(contents)).unlid);
  // OpenCode overlays stored API credentials after environment credentials.
  return (Option.isSome(apiAuth) ? apiAuth.value.key : env.UNLID_API_KEY)?.trim();
});

/** What the Unlid probe adds to a subscription's limits: the prepaid balance. */
export type UnlidLimits = SubscriptionLimits & {
  readonly balance?: ServerProviderUsageBalance | undefined;
};

interface UnlidAccountInput {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Unlid's prepaid balance for the account OpenCode is signed in to. It is never
 * a usage window: the balance is the whole story.
 *
 * External OpenCode servers own their credentials; never read the host's account for them.
 */
export const readUnlidUsageLimits = Effect.fn("readUnlidUsageLimits")(function* (
  input: UnlidAccountInput,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  const unavailable = ({
    reason,
    message,
    credentialFingerprint,
  }: {
    readonly reason: "unsupported" | "probeFailed";
    readonly message?: string;
    readonly credentialFingerprint?: string;
  }): UnlidLimits => ({
    ...makeUnavailableUsageLimits({
      checkedAt,
      reason,
      ...(message ? { message } : {}),
    }),
    ...(credentialFingerprint ? { credentialFingerprint } : {}),
  });

  if (!input.enabled || input.serverUrl.trim()) return unavailable({ reason: "unsupported" });

  return yield* Effect.gen(function* () {
    const apiKey = yield* readApiKey(input.environment).pipe(Effect.timeout("5 seconds"));
    if (!apiKey) {
      return unavailable({ reason: "unsupported", message: "No Unlid API key found." });
    }

    // Unlid's responses have no account ID. An unkeyed hash matches across
    // environments without a shared secret. It permits offline guesses, but
    // Unlid keys are randomly generated. Published even when the probe fails,
    // so the account keeps its place on the Limits page.
    const credentialFingerprint = yield* sha256Hex(`unlid\0${apiKey}`);

    const succeeded = (balance: ServerProviderUsageBalance): UnlidLimits => ({
      ...makeUsageLimits({ checkedAt, windows: [] }),
      credentialFingerprint,
      balance,
      externalUsage: { label: "Balance & billing", url: "https://unlid.ai/account/billing" },
    });

    return yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.get(`${API_ORIGIN}/v1/me`).pipe(HttpClientRequest.bearerToken(apiKey)),
      );
      // A valid key on an account that has not topped up yet; the body names nothing.
      if (response.status === 402) return succeeded({ balanceUsd: 0 });
      if (response.status === 401 || response.status === 403) {
        return unavailable({
          reason: "unsupported",
          message: "Unlid rejected the key.",
          credentialFingerprint,
        });
      }
      const me = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(MeResponse)),
      );
      // The balance schema is non-negative; an overdraft clamps to empty rather than failing.
      return succeeded({
        balanceUsd: Math.max(0, me.balance_usd),
        ...(me.held_usd === undefined ? {} : { heldUsd: Math.max(0, me.held_usd) }),
        ...(me.month_spend_usd === undefined
          ? {}
          : { monthSpendUsd: Math.max(0, me.month_spend_usd) }),
      });
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() =>
        unavailable({
          reason: "probeFailed",
          message: "Unlid could not read the balance.",
          credentialFingerprint,
        }),
      ),
    );
  }).pipe(
    Effect.orElseSucceed(() =>
      unavailable({ reason: "probeFailed", message: "Unlid could not read the balance." }),
    ),
  );
});
