import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const AuthFile = Schema.Struct({ "ollama-cloud": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);

/** `usage` is the used fraction, 0 to 1. Per-model counts and activity are ignored. */
const UsageWindow = Schema.Struct({ usage: Schema.Finite });
/** Plans on a monthly pool report `monthly`; older plans report `session` and `weekly`. */
const UsageResponse = Schema.Struct({
  limits: Schema.optionalKey(
    Schema.Struct({
      session: Schema.optionalKey(UsageWindow),
      weekly: Schema.optionalKey(UsageWindow),
      monthly: Schema.optionalKey(UsageWindow),
    }),
  ),
});

const WINDOWS: ReadonlyArray<
  Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins"> & {
    readonly key: "session" | "weekly" | "monthly";
  }
> = [
  {
    key: "session",
    id: "ollama_session",
    kind: "session",
    label: "Ollama · Session",
    windowDurationMins: 5 * 60,
  },
  {
    key: "weekly",
    id: "ollama_weekly",
    kind: "weekly",
    label: "Ollama · Weekly",
    windowDurationMins: 7 * 24 * 60,
  },
  { key: "monthly", id: "ollama_monthly", kind: "monthly", label: "Ollama · Monthly" },
];

/** The key OpenCode stored for this account, else `OLLAMA_API_KEY`. */
const readApiKey = Effect.fn("readOllamaCloudApiKey")(function* (env: NodeJS.ProcessEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataHome =
    env.XDG_DATA_HOME ||
    path.join(env.HOME || env.USERPROFILE || NodeOS.homedir(), ".local", "share");
  const contents =
    env.OPENCODE_AUTH_CONTENT ||
    (yield* fs.readFileString(path.join(dataHome, "opencode", "auth.json")).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
    ));
  const apiAuth = decodeApiAuth((yield* decodeAuthFile(contents))["ollama-cloud"]);
  // OpenCode overlays stored API credentials after environment credentials.
  return (Option.isSome(apiAuth) ? apiAuth.value.key : env.OLLAMA_API_KEY)?.trim();
});

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOllamaCloudUsageLimits = Effect.fn("readOllamaCloudUsageLimits")(
  function* (input: {
    readonly enabled: boolean;
    readonly serverUrl: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    if (!input.enabled || input.serverUrl.trim()) return unsupported;

    const probeFailed = (credentialFingerprint?: string) => ({
      ...makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Ollama Cloud could not read usage.",
      }),
      ...(credentialFingerprint ? { credentialFingerprint } : {}),
    });

    return yield* Effect.gen(function* () {
      const apiKey = yield* readApiKey(input.environment).pipe(Effect.timeout("5 seconds"));
      if (!apiKey) return unsupported;

      // Ollama's usage response has no account ID. An unkeyed hash matches across
      // environments without a shared secret. It permits offline guesses, but
      // Ollama keys are randomly generated. Published even when the probe fails,
      // so the account keeps its place on the Limits page.
      const credentialFingerprint = NodeCrypto.createHash("sha256")
        .update("ollama-cloud\0")
        .update(apiKey)
        .digest("hex");

      return yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(
          HttpClientRequest.get("https://ollama.com/api/usage").pipe(
            HttpClientRequest.bearerToken(apiKey),
          ),
        );
        // A valid key can exist without a paid plan.
        if (response.status === 403) return unsupported;
        const { limits } = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
        );
        // Ollama reports no reset time, so the windows carry none.
        const windows = WINDOWS.flatMap(({ key, ...window }): ServerProviderUsageWindow[] => {
          const reported = limits?.[key];
          return reported ? [{ ...window, usedPercent: clampPercent(reported.usage * 100) }] : [];
        });
        if (windows.length === 0) return unsupported;
        return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint };
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => probeFailed(credentialFingerprint)),
      );
    }).pipe(Effect.orElseSucceed(() => probeFailed()));
  },
);
