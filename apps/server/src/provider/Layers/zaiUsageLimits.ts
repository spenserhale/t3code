import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "../providerUsageLimits.ts";

const API_ORIGIN = "https://api.z.ai";

const AuthFile = Schema.Struct({ "zai-coding-plan": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);

/** Z.ai reports failures as HTTP 200 with `success: false`, so the envelope is checked too. */
const envelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({ success: Schema.Literal(true), data });

const QuotaResponse = envelope(
  Schema.Struct({
    limits: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        unit: Schema.Finite,
        percentage: Schema.Finite,
        nextResetTime: Schema.optionalKey(Schema.Finite),
      }),
    ),
  }),
);

const ResetRecord = Schema.Struct({
  recordId: Schema.Finite,
  expireTime: Schema.String,
  available: Schema.Boolean,
});
const ResetListResponse = envelope(
  Schema.Struct({
    fiveHourResets: Schema.Array(ResetRecord),
    weekResets: Schema.Array(ResetRecord),
  }),
);
const UseResetResponse = Schema.Struct({
  success: Schema.Boolean,
  msg: Schema.optionalKey(Schema.String),
});

/** Z.ai answered the redemption with `success: false`; `detail` is its own wording. */
export class ZaiResetRejected extends Schema.TaggedError<ZaiResetRejected>()("ZaiResetRejected", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Z.ai rejected the quota reset: ${this.detail}`;
  }
}

type ResetType = "FIVE_HOUR" | "WEEK";
interface ResetCredit {
  readonly resetType: ResetType;
  readonly recordId: number;
  readonly expiresAt: string | undefined;
}

/** Quota windows by Z.ai's `type:unit` pair; `TIME_LIMIT` is the monthly MCP tool allowance. */
const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "windowDurationMins">>
> = {
  "TOKENS_LIMIT:3": {
    id: "zai_five_hour",
    kind: "session",
    label: "Z.ai · 5 hours",
    windowDurationMins: 5 * 60,
  },
  "TOKENS_LIMIT:6": {
    id: "zai_weekly",
    kind: "weekly",
    label: "Z.ai · Weekly",
    windowDurationMins: 7 * 24 * 60,
  },
  "TIME_LIMIT:5": { id: "zai_tools_monthly", kind: "monthly", label: "Z.ai · Tools" },
};

/** The Coding Plan key OpenCode stored for this account, if it has one. */
const readApiKey = Effect.fn("readZaiCodingPlanApiKey")(function* (env: NodeJS.ProcessEnv) {
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
  const auth = decodeApiAuth((yield* decodeAuthFile(contents))["zai-coding-plan"]);
  return Option.isSome(auth) ? auth.value.key.trim() || undefined : undefined;
});

/** Z.ai takes the raw key, without a `Bearer` prefix. */
const authorize = (request: HttpClientRequest.HttpClientRequest, apiKey: string) =>
  request.pipe(
    HttpClientRequest.setHeader("Authorization", apiKey),
    HttpClientRequest.setHeader("Accept-Language", "en-US"),
  );

const getJson = <S extends Schema.Top>(apiKey: string, pathname: string, schema: S) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      authorize(HttpClientRequest.get(`${API_ORIGIN}${pathname}`), apiKey),
    );
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    );
  });

/**
 * Z.ai prints expiry as wall-clock time with no zone. Its platform runs on
 * UTC+8, which is close enough for a label that reads in days.
 */
function expiryToIso(expireTime: string): string | undefined {
  const parsed = DateTime.make(`${expireTime.trim().replace(" ", "T")}+08:00`);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

const readResetCredits = (apiKey: string) =>
  getJson(
    apiKey,
    "/api/biz/customer-package-reset/list?targetType=PERSONAL",
    ResetListResponse,
  ).pipe(
    Effect.map(({ data }) => {
      const credits = (resetType: ResetType, records: typeof data.weekResets) =>
        records
          .filter((record) => record.available)
          .map((record): ResetCredit => ({
            resetType,
            recordId: record.recordId,
            expiresAt: expiryToIso(record.expireTime),
          }))
          .toSorted((left, right) => (left.expiresAt ?? "").localeCompare(right.expiresAt ?? ""));
      return {
        fiveHour: credits("FIVE_HOUR", data.fiveHourResets),
        week: credits("WEEK", data.weekResets),
      };
    }),
  );

/**
 * A weekly reset also clears the 5-hour window, so it is only worth spending
 * when the week is the fuller of the two; otherwise the cheaper 5-hour reset
 * goes first.
 */
function nextResetCredit(
  credits: { readonly fiveHour: readonly ResetCredit[]; readonly week: readonly ResetCredit[] },
  windows: readonly ServerProviderUsageWindow[],
): ResetCredit | undefined {
  const used = (id: string) => windows.find((window) => window.id === id)?.usedPercent ?? 0;
  const [fiveHour] = credits.fiveHour;
  const [week] = credits.week;
  if (fiveHour && week) return used("zai_weekly") > used("zai_five_hour") ? week : fiveHour;
  return fiveHour ?? week;
}

const readWindows = (apiKey: string) =>
  getJson(apiKey, "/api/monitor/usage/quota/limit", QuotaResponse).pipe(
    Effect.map(({ data }) =>
      data.limits.flatMap((limit): ServerProviderUsageWindow[] => {
        const window = WINDOWS[`${limit.type}:${limit.unit}`];
        if (window === undefined) return [];
        const resetsAt =
          limit.nextResetTime === undefined ? Option.none() : DateTime.make(limit.nextResetTime);
        return [
          {
            ...window,
            usedPercent: clampPercent(limit.percentage),
            ...(Option.isSome(resetsAt) ? { resetsAt: DateTime.formatIso(resetsAt.value) } : {}),
          },
        ];
      }),
    ),
  );

interface ZaiAccountInput {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Z.ai Coding Plan quota for the account OpenCode is signed in to.
 *
 * External OpenCode servers own their credentials; never read the host's
 * account for them.
 */
export const readZaiCodingPlanUsageLimits = Effect.fn("readZaiCodingPlanUsageLimits")(function* (
  input: ZaiAccountInput,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  const probeFailed = (credentialFingerprint?: string) => ({
    ...makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Z.ai could not read Coding Plan usage.",
    }),
    ...(credentialFingerprint ? { credentialFingerprint } : {}),
  });

  return yield* Effect.gen(function* () {
    const apiKey = yield* readApiKey(input.environment).pipe(Effect.timeout("5 seconds"));
    if (!apiKey) return unsupported;

    // Z.ai's quota response has no account ID. An unkeyed hash matches across
    // environments without a shared secret. It permits offline guesses, but
    // Z.ai keys are randomly generated. Published even when the probe fails,
    // so the account keeps its place on the Limits page.
    const credentialFingerprint = NodeCrypto.createHash("sha256")
      .update("zai-coding-plan\0")
      .update(apiKey)
      .digest("hex");

    return yield* Effect.gen(function* () {
      const windows = yield* readWindows(apiKey);
      // A reset-list outage must not hide the quota bars.
      const credits = yield* readResetCredits(apiKey).pipe(Effect.option);
      const limits = { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint };
      if (Option.isNone(credits)) return limits;

      const next = nextResetCredit(credits.value, limits.windows);
      const resetCredits: ServerProviderResetCredits = {
        availableCount: credits.value.fiveHour.length + credits.value.week.length,
        ...(next ? { nextCreditId: `${next.resetType}:${next.recordId}` } : {}),
        ...(next?.expiresAt ? { nextExpiresAt: next.expiresAt } : {}),
      };
      return { ...limits, resetCredits };
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => probeFailed(credentialFingerprint)),
    );
  }).pipe(Effect.orElseSucceed(() => probeFailed()));
});

/**
 * Spends one Coding Plan quota reset. Irreversible, and Z.ai grants about one
 * a week, so callers confirm with the user first.
 */
export const consumeZaiResetCredit = Effect.fn("consumeZaiResetCredit")(function* (
  input: ZaiAccountInput,
) {
  if (!input.enabled || input.serverUrl.trim()) return "noCredit" as const;
  const apiKey = yield* readApiKey(input.environment);
  if (!apiKey) return "noCredit" as const;

  const [windows, credits] = yield* Effect.all([readWindows(apiKey), readResetCredits(apiKey)], {
    concurrency: 2,
  });
  const credit = nextResetCredit(credits, windows);
  if (credit === undefined) return "noCredit" as const;
  if (windows.every((window) => window.kind === "monthly" || window.usedPercent === 0)) {
    return "nothingToReset" as const;
  }

  const requestId = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    authorize(
      HttpClientRequest.post(`${API_ORIGIN}/api/biz/customer-package-reset/use`),
      apiKey,
    ).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        targetType: "PERSONAL",
        resetType: credit.resetType,
        recordId: credit.recordId,
        requestId,
      }),
    ),
  );
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(UseResetResponse)),
  );
  if (!body.success) {
    return yield* new ZaiResetRejected({ detail: body.msg?.trim() || "no reason given" });
  }
  return "reset" as const satisfies ProviderConsumeResetCreditOutcome;
}, Effect.timeout("20 seconds"));

/**
 * One OpenCode account can hold several subscriptions. Windows from each
 * available probe are shown together; when none is available the first
 * failure explains why. An account has a single identity slot, so the set of
 * credentials names it: one fingerprint passes through unchanged (matching
 * what a server without Z.ai publishes), several are hashed together. Inputs
 * may be remembered results of different ages, so the combined result is
 * stamped with the oldest `checkedAt` among those it was built from.
 */
export function combineUsageLimits(
  limits: readonly [ServerProviderUsageLimits, ...ServerProviderUsageLimits[]],
): ServerProviderUsageLimits {
  const available = limits.filter((entry) => entry.unavailable === undefined);
  if (available.length === 0) {
    return limits.find((entry) => entry.unavailable?.reason === "probeFailed") ?? limits[0];
  }
  const resetCredits = available.find((entry) => entry.resetCredits !== undefined)?.resetCredits;
  const fingerprints = [
    ...new Set(limits.flatMap((entry) => entry.credentialFingerprint ?? [])),
  ].toSorted();
  const credentialFingerprint =
    fingerprints.length > 1
      ? NodeCrypto.createHash("sha256").update(fingerprints.join("\0")).digest("hex")
      : fingerprints[0];
  // Every producer formats `checkedAt` with `DateTime.formatIso`, so the
  // strings order the same way as the instants.
  const checkedAt = available.reduce((oldest, entry) =>
    entry.checkedAt < oldest.checkedAt ? entry : oldest,
  ).checkedAt;
  return {
    ...makeUsageLimits({
      checkedAt,
      windows: available.flatMap((entry) => entry.windows),
    }),
    ...(credentialFingerprint ? { credentialFingerprint } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

/**
 * Gives one subscription probe a memory. Create the wrapped probe once, where
 * the provider is built, and run it on every refresh: a read that failed this
 * time returns that subscription's last good result instead, so a brief
 * outage keeps its bars and fingerprint in the combined result.
 * `unsupported` replaces the memory, as it does for the provider as a whole,
 * and so does a failure that names a different credential, which is a
 * different account.
 */
export const keepLastGoodUsageLimits = <E, R>(
  probe: Effect.Effect<ServerProviderUsageLimits, E, R>,
) =>
  Effect.map(Ref.make<ServerProviderUsageLimits | undefined>(undefined), (published) =>
    Effect.flatMap(probe, (probed) =>
      Ref.modify(published, (last) => {
        const otherAccount =
          probed.credentialFingerprint !== undefined &&
          probed.credentialFingerprint !== last?.credentialFingerprint;
        const next = otherAccount
          ? probed
          : (resolveUsageLimitsAfterProbe({ published: last, probed }) ?? probed);
        return [next, next] as const;
      }),
    ),
  );
