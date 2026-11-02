import {
  ForwardCompatibleArray,
  ForwardCompatibleOptional,
  type ServerProviderUsageCredit,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  OllamaCloudValuation,
  type OllamaCloudModelUsage,
  type OllamaCloudValueInput,
} from "./ollamaCloudMarket.ts";
import type { SubscriptionLimits } from "./zaiUsageLimits.ts";

const API_ORIGIN = "https://ollama.com";

/** Ollama allows 10 requests a minute across every device, and usage lags anyway. */
const USAGE_CACHE_MS = 10 * 60_000;

const AuthFile = Schema.Struct({ "ollama-cloud": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);

// Neither endpoint has been called with a real key, so each field decodes on its own:
// one that is missing or odd leaves its part out instead of failing the whole read.
const number = ForwardCompatibleOptional(Schema.Finite);

const LegacyLimit = Schema.Struct({
  remaining_percent: Schema.Finite,
  resets_at: ForwardCompatibleOptional(Schema.String),
});

/** Plans on a monthly credit pool report `balance_usd`; older ones report `session` and `weekly`. */
const BalanceResponse = Schema.Struct({
  included: Schema.Struct({
    balance_usd: number,
    allowance_usd: number,
    period: ForwardCompatibleOptional(Schema.Struct({ from: Schema.String, until: Schema.String })),
    session: ForwardCompatibleOptional(LegacyLimit),
    weekly: ForwardCompatibleOptional(LegacyLimit),
  }),
  purchased: ForwardCompatibleOptional(Schema.Struct({ balance_usd: number })),
});

const UsageGroup = Schema.Struct({
  model: Schema.String,
  usage_usd: number,
  input_tokens: number,
  cached_input_tokens: number,
  output_tokens: number,
});
const UsageBucket = Schema.Struct({
  from: Schema.String,
  until: Schema.String,
  groups: ForwardCompatibleOptional(ForwardCompatibleArray(UsageGroup)),
  remainder: ForwardCompatibleOptional(Schema.Struct({ usage_usd: number })),
});
const UsageResponse = Schema.Struct({ buckets: ForwardCompatibleArray(UsageBucket) });
type UsageBuckets = typeof UsageResponse.Type.buckets;

const CREDIT_WINDOW = {
  id: "ollama_monthly",
  kind: "monthly",
  label: "Ollama · Monthly credit",
} as const;

const LEGACY_WINDOWS = [
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
] as const;

/** What a plan costs for a period, by the size of the credit pool it includes. */
const PLAN_PRICES_USD: ReadonlyMap<number, number> = new Map([
  [60, 20],
  [300, 100],
  [1000, 500],
]);

/** Two decimals keep float noise (27.500000000000004) off the wire. */
const toPercent = (value: number) => clampPercent(Math.round(value * 100) / 100);

interface CreditPool {
  readonly allowanceUsd: number;
  readonly balanceUsd: number;
  readonly periodStart: DateTime.Utc;
  readonly periodEnd: DateTime.Utc;
}

/** The windows a balance describes, and its credit pool when the period is readable. */
function readIncluded(included: typeof BalanceResponse.Type.included): {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly pool: CreditPool | undefined;
} {
  const { allowance_usd: allowance, balance_usd: balance } = included;
  if (allowance !== undefined && allowance > 0 && balance !== undefined) {
    const used = Math.min(allowance, Math.max(0, allowance - balance));
    const start = included.period ? DateTime.make(included.period.from) : Option.none();
    const end = included.period ? DateTime.make(included.period.until) : Option.none();
    const period =
      Option.isSome(start) &&
      Option.isSome(end) &&
      end.value.epochMilliseconds > start.value.epochMilliseconds
        ? { start: start.value, end: end.value }
        : undefined;
    return {
      windows: [
        {
          ...CREDIT_WINDOW,
          usedPercent: toPercent((used / allowance) * 100),
          ...(period
            ? {
                resetsAt: DateTime.formatIso(period.end),
                windowDurationMins: Math.round(
                  (period.end.epochMilliseconds - period.start.epochMilliseconds) / 60_000,
                ),
              }
            : {}),
        },
      ],
      pool: period
        ? {
            allowanceUsd: allowance,
            balanceUsd: Math.max(0, balance),
            periodStart: period.start,
            periodEnd: period.end,
          }
        : undefined,
    };
  }
  return {
    windows: LEGACY_WINDOWS.flatMap(({ key, ...window }): ServerProviderUsageWindow[] => {
      const limit = included[key];
      if (limit === undefined) return [];
      const resetsAt =
        limit.resets_at === undefined ? Option.none() : DateTime.make(limit.resets_at);
      return [
        {
          ...window,
          usedPercent: toPercent(100 - limit.remaining_percent),
          ...(Option.isSome(resetsAt) ? { resetsAt: DateTime.formatIso(resetsAt.value) } : {}),
        },
      ];
    }),
    pool: undefined,
  };
}

/** Usage of the buckets that overlap the period; the first one may straddle its start. */
function periodUsage(
  buckets: UsageBuckets,
  period: { readonly start: DateTime.Utc; readonly end: DateTime.Utc },
): Pick<OllamaCloudValueInput, "models" | "remainderUsageUsd"> {
  const models = new Map<string, OllamaCloudModelUsage>();
  let remainderUsageUsd = 0;
  for (const bucket of buckets) {
    const from = DateTime.make(bucket.from);
    const until = DateTime.make(bucket.until);
    if (
      Option.isNone(from) ||
      Option.isNone(until) ||
      until.value.epochMilliseconds <= period.start.epochMilliseconds ||
      from.value.epochMilliseconds >= period.end.epochMilliseconds
    ) {
      continue;
    }
    remainderUsageUsd += bucket.remainder?.usage_usd ?? 0;
    for (const group of bucket.groups ?? []) {
      const previous = models.get(group.model);
      models.set(group.model, {
        model: group.model,
        usageUsd: (previous?.usageUsd ?? 0) + (group.usage_usd ?? 0),
        inputTokens: (previous?.inputTokens ?? 0) + (group.input_tokens ?? 0),
        cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (group.cached_input_tokens ?? 0),
        outputTokens: (previous?.outputTokens ?? 0) + (group.output_tokens ?? 0),
      });
    }
  }
  return { models: [...models.values()], remainderUsageUsd };
}

/** The key OpenCode stored for this account, else `OLLAMA_API_KEY`. */
const readApiKey = Effect.fn("readOllamaCloudApiKey")(function* (env: NodeJS.ProcessEnv) {
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
  const apiAuth = decodeApiAuth((yield* decodeAuthFile(contents))["ollama-cloud"]);
  // OpenCode overlays stored API credentials after environment credentials.
  return (Option.isSome(apiAuth) ? apiAuth.value.key : env.OLLAMA_API_KEY)?.trim();
});

interface OllamaCloudAccountInput {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Ollama Cloud usage limits for the account OpenCode is signed in to. Build it once, where the
 * provider is built: it remembers the usage history. The credit pool rides beside the limits, and
 * only `combineUsageLimits` puts it on the wire, inside the subscription.
 */
export const makeOllamaCloudUsageLimits = Effect.fn("makeOllamaCloudUsageLimits")(function* (
  input: OllamaCloudAccountInput,
) {
  const valuation = yield* Effect.serviceOption(OllamaCloudValuation);
  const usageCache = yield* Ref.make<
    | { readonly fingerprint: string; readonly readAtMs: number; readonly buckets: UsageBuckets }
    | undefined
  >(undefined);

  const readUsage = Effect.fn("readOllamaCloudUsage")(function* (
    apiKey: string,
    fingerprint: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(usageCache);
    if (cached?.fingerprint === fingerprint && now - cached.readAtMs < USAGE_CACHE_MS) {
      return cached.buckets;
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${API_ORIGIN}/api/usage`).pipe(
        HttpClientRequest.setUrlParams({ range: "30d", group_by: "model" }),
        HttpClientRequest.bearerToken(apiKey),
      ),
    );
    const { buckets } = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    yield* Ref.set(usageCache, { fingerprint, readAtMs: now, buckets });
    return buckets;
  });

  /** The limits a balance describes, or undefined when it names none or the account is suspended. */
  const readBalance = Effect.fn("readOllamaCloudBalance")(function* (apiKey: string) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${API_ORIGIN}/api/balance`).pipe(
        HttpClientRequest.bearerToken(apiKey),
      ),
    );
    if (response.status === 403) return undefined;
    const balance = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(BalanceResponse)),
    );
    const { windows, pool } = readIncluded(balance.included);
    if (windows.length === 0) return undefined;
    return { windows, pool, purchasedUsd: Math.max(0, balance.purchased?.balance_usd ?? 0) };
  });

  // Whatever goes wrong here only leaves the value out; the pool and the bar do not depend on it.
  const readCredit = Effect.fn("readOllamaCloudCredit")(function* (
    pool: CreditPool,
    purchasedUsd: number,
    apiKey: string,
    fingerprint: string,
  ) {
    const usedUsd = Math.max(0, pool.allowanceUsd - pool.balanceUsd);
    const value =
      Option.isSome(valuation) && usedUsd > 0
        ? yield* readUsage(apiKey, fingerprint).pipe(
            Effect.map((buckets) =>
              periodUsage(buckets, { start: pool.periodStart, end: pool.periodEnd }),
            ),
            Effect.flatMap((usage) => valuation.value.openRouterValueUsd({ usedUsd, ...usage })),
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
    const planPriceUsd = PLAN_PRICES_USD.get(pool.allowanceUsd);
    return {
      allowanceUsd: pool.allowanceUsd,
      balanceUsd: pool.balanceUsd,
      ...(purchasedUsd > 0 ? { purchasedBalanceUsd: purchasedUsd } : {}),
      periodStart: DateTime.formatIso(pool.periodStart),
      periodEnd: DateTime.formatIso(pool.periodEnd),
      ...(planPriceUsd === undefined ? {} : { planPriceUsd }),
      ...(value === undefined ? {} : { openRouterValueUsd: value }),
    } satisfies ServerProviderUsageCredit;
  });

  /** External OpenCode servers own their credentials; never read the host's account for them. */
  const readLimits = Effect.fn("readOllamaCloudUsageLimits")(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const unsupported: SubscriptionLimits = makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
    });
    if (!input.enabled || input.serverUrl.trim()) return unsupported;

    const probeFailed = (credentialFingerprint?: string): SubscriptionLimits => ({
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

      // Ollama's responses have no account ID. An unkeyed hash matches across
      // environments without a shared secret. It permits offline guesses, but
      // Ollama keys are randomly generated. Published even when the probe fails,
      // so the account keeps its place on the Limits page.
      const crypto = yield* Crypto.Crypto;
      const credentialFingerprint = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`ollama-cloud\0${apiKey}`))
        .pipe(Effect.map(Hex.encode), Effect.orDie);

      const balance = yield* readBalance(apiKey).pipe(Effect.timeout("5 seconds"), Effect.option);
      if (Option.isNone(balance)) return probeFailed(credentialFingerprint);
      if (balance.value === undefined) return unsupported;
      const { windows, pool, purchasedUsd } = balance.value;
      const credit = pool
        ? yield* readCredit(pool, purchasedUsd, apiKey, credentialFingerprint)
        : undefined;
      const limits: SubscriptionLimits = {
        ...makeUsageLimits({ checkedAt, windows }),
        credentialFingerprint,
        ...(credit ? { credit } : {}),
      };
      return limits;
    }).pipe(Effect.orElseSucceed(() => probeFailed()));
  });
  return readLimits();
});
