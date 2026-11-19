import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";

import { OllamaCloudValuation, type OllamaCloudValueInput } from "./ollamaCloudMarket.ts";
import { makeOllamaCloudUsageLimits } from "./ollamaCloudUsageLimits.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const account = (
  key: string | null = "ollama-key",
  overrides: {
    readonly enabled?: boolean;
    readonly serverUrl?: string;
    readonly env?: object;
  } = {},
) => ({
  enabled: overrides.enabled ?? true,
  serverUrl: overrides.serverUrl ?? "",
  environment: {
    OPENCODE_AUTH_CONTENT: encodeJson(key ? { "ollama-cloud": { type: "api", key } } : {}),
    ...overrides.env,
  },
});

// The examples on https://docs.ollama.com/api/balance and /api/cloud-usage.
const BALANCE = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" },
  },
  purchased: { balance_usd: 25 },
};
const LEGACY_BALANCE = {
  included: {
    session: { remaining_percent: 75, resets_at: "2026-10-01T07:00:00Z" },
    weekly: { remaining_percent: 40, resets_at: "2026-10-05T00:00:00Z" },
  },
  purchased: { balance_usd: 25 },
};
const group = (
  model: string,
  usage_usd: number,
  input: number,
  cached: number,
  output: number,
) => ({
  model,
  request_count: 1,
  usage_usd,
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
});
const USAGE = {
  range: "30d",
  scope: "self",
  granularity: "day",
  group_by: "model",
  from: "2026-09-02T00:00:00Z",
  until: "2026-10-01T02:30:00Z",
  totals: { request_count: 20, usage_usd: 0.1 },
  buckets: [
    {
      from: "2026-09-10T00:00:00Z",
      until: "2026-09-11T00:00:00Z",
      groups: [group("glm-5.3", 5, 1_000_000, 0, 100_000)],
    },
    // The period began at 09:30 on the 15th, in the middle of this day: some of it is from before.
    {
      from: "2026-09-15T00:00:00Z",
      until: "2026-09-16T00:00:00Z",
      groups: [group("glm-5.3", 0.002, 1000, 0, 200)],
    },
    {
      from: "2026-09-30T00:00:00Z",
      until: "2026-10-01T00:00:00Z",
      groups: [
        group("glm-5.3-flash", 0.0066, 48000, 30000, 6000),
        group("glm-5.3", 0.01, 4000, 0, 1000),
      ],
      remainder: { request_count: 1, usage_usd: 0.001 },
    },
    {
      from: "2026-10-01T00:00:00Z",
      until: "2026-10-01T02:30:00Z",
      partial: true,
      groups: [
        group("glm-5.3-flash", 0.0066, 48000, 30000, 6000),
        group("gpt-oss:120b", 0.0036, 16000, 0, 2000),
      ],
    },
  ],
};

/** A body, a bare status, or a function that makes a response. */
type Routes = Record<string, unknown>;

/** A 429, with the `Retry-After` Ollama sends when it has one. */
const throttled = (retryAfterSeconds?: number) => () =>
  new Response(null, {
    status: 429,
    ...(retryAfterSeconds === undefined
      ? {}
      : { headers: { "retry-after": String(retryAfterSeconds) } }),
  });

/** Answers each Ollama path with its body (or a bare status) and records the requests. */
function ollamaApi(routes: Routes) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  /** Paths whose requests are never answered. */
  const stalled = new Set<string>();
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request);
        if (stalled.has(new URL(request.url).pathname)) return Effect.never;
        const response = routes[new URL(request.url).pathname];
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            response === undefined
              ? new Response(null, { status: 404 })
              : typeof response === "function"
                ? (response as () => Response)()
                : typeof response === "number"
                  ? new Response(null, { status: response })
                  : Response.json(response),
          ),
        );
      }),
    ),
  );
  const paths = () => requests.map((request) => new URL(request.url).pathname);
  return { layer, requests, paths, routes, stalled };
}

/** A valuation that records what it was asked and answers with `value`. */
function valuation(value: number | undefined) {
  const inputs: OllamaCloudValueInput[] = [];
  const layer = Layer.succeed(OllamaCloudValuation, {
    openRouterValueUsd: (input) => Effect.sync(() => (inputs.push(input), value)),
  });
  return { layer, inputs };
}

/** One probe of a freshly built reader, as the driver builds it once and runs it on every refresh. */
const readOnce = (input: ReturnType<typeof account>) =>
  makeOllamaCloudUsageLimits(input).pipe(Effect.flatten);

const summary = (limits: ServerProviderUsageLimits) =>
  limits.windows.map((window) => [window.id, window.kind, window.usedPercent]);

describe("makeOllamaCloudUsageLimits", () => {
  it.effect("reads a credit pool as one monthly window, with the credit and no usage call", () => {
    const api = ollamaApi({ "/api/balance": BALANCE });
    return Effect.gen(function* () {
      const limits = yield* readOnce(account());
      assert.deepStrictEqual(summary(limits), [["ollama_monthly", "monthly", 27.5]]);
      const [window] = limits.windows;
      assert.strictEqual(window?.label, "Ollama · Monthly credit");
      assert.strictEqual(window?.resetsAt, "2026-10-15T09:30:00.000Z");
      assert.strictEqual(window?.windowDurationMins, 30 * 24 * 60);
      assert.isUndefined(limits.unavailable);
      assert.deepStrictEqual(limits.credit, {
        allowanceUsd: 100,
        balanceUsd: 72.5,
        purchasedBalanceUsd: 25,
        periodStart: "2026-09-15T09:30:00.000Z",
        periodEnd: "2026-10-15T09:30:00.000Z",
      });
      // Without a valuation there is nothing to fetch the history for.
      assert.deepStrictEqual(api.paths(), ["/api/balance"]);
      assert.strictEqual(api.requests[0]?.headers["authorization"], "Bearer ollama-key");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("names the plan from the size of its credit pool", () =>
    Effect.gen(function* () {
      const prices: Array<number | undefined> = [];
      for (const allowance of [60, 300, 1000, 100]) {
        const api = ollamaApi({
          "/api/balance": {
            ...BALANCE,
            included: { ...BALANCE.included, allowance_usd: allowance, balance_usd: allowance },
          },
        });
        const limits = yield* readOnce(account()).pipe(Effect.provide(api.layer));
        prices.push(limits.credit?.planPriceUsd);
      }
      assert.deepStrictEqual(prices, [20, 100, 500, undefined]);
    }),
  );

  it.effect("reads the session and weekly windows of an older plan, with their reset times", () => {
    const api = ollamaApi({ "/api/balance": LEGACY_BALANCE });
    return Effect.gen(function* () {
      const limits = yield* readOnce(account());
      assert.deepStrictEqual(summary(limits), [
        ["ollama_session", "session", 25],
        ["ollama_weekly", "weekly", 60],
      ]);
      assert.deepStrictEqual(
        limits.windows.map((window) => [window.resetsAt, window.windowDurationMins]),
        [
          ["2026-10-01T07:00:00.000Z", 5 * 60],
          ["2026-10-05T00:00:00.000Z", 7 * 24 * 60],
        ],
      );
      assert.isUndefined(limits.credit);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("clamps a pool that is overspent or topped up", () => {
    const read = (balance_usd: number) =>
      readOnce(account()).pipe(
        Effect.provide(
          ollamaApi({
            "/api/balance": { included: { ...BALANCE.included, balance_usd } },
          }).layer,
        ),
      );
    return Effect.gen(function* () {
      const overspent = yield* read(-3);
      const toppedUp = yield* read(130);
      assert.strictEqual(overspent.windows[0]?.usedPercent, 100);
      assert.strictEqual(overspent.credit?.balanceUsd, 0);
      assert.strictEqual(toppedUp.windows[0]?.usedPercent, 0);
    });
  });

  it.effect("keeps the bar when the period cannot be read, and leaves the credit out", () => {
    const api = ollamaApi({
      "/api/balance": { included: { balance_usd: 30, allowance_usd: 60, period: { from: "?" } } },
    });
    return Effect.gen(function* () {
      const limits = yield* readOnce(account());
      assert.deepStrictEqual(summary(limits), [["ollama_monthly", "monthly", 50]]);
      assert.isUndefined(limits.windows[0]?.resetsAt);
      assert.isUndefined(limits.credit);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("is unsupported without a key and never calls Ollama", () => {
    const api = ollamaApi({ "/api/balance": BALANCE });
    return Effect.gen(function* () {
      const limits = yield* readOnce(account(null));
      assert.strictEqual(limits.unavailable?.reason, "unsupported");
      assert.isUndefined(limits.credentialFingerprint);
      assert.strictEqual(api.requests.length, 0);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("never calls Ollama when disabled or pointed at an external server", () => {
    const api = ollamaApi({ "/api/balance": BALANCE });
    return Effect.gen(function* () {
      for (const input of [
        account("ollama-key", { enabled: false }),
        account("ollama-key", { serverUrl: "http://remote.example:4096" }),
      ]) {
        const limits = yield* readOnce(input);
        assert.strictEqual(limits.unavailable?.reason, "unsupported");
      }
      assert.strictEqual(api.requests.length, 0);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("is unsupported when the balance names no limit or the account is suspended", () =>
    Effect.gen(function* () {
      const none = yield* readOnce(account()).pipe(
        Effect.provide(ollamaApi({ "/api/balance": { included: {}, purchased: {} } }).layer),
      );
      const free = yield* readOnce(account()).pipe(
        Effect.provide(
          ollamaApi({
            "/api/balance": { included: { balance_usd: 0, allowance_usd: 0 } },
          }).layer,
        ),
      );
      const suspended = yield* readOnce(account()).pipe(
        Effect.provide(ollamaApi({ "/api/balance": 403 }).layer),
      );
      assert.deepStrictEqual(
        [none, free, suspended].map((limits) => limits.unavailable?.reason),
        ["unsupported", "unsupported", "unsupported"],
      );
    }),
  );

  it.effect("falls back to OLLAMA_API_KEY, but a stored key wins", () => {
    const api = ollamaApi({ "/api/balance": BALANCE });
    return Effect.gen(function* () {
      yield* readOnce(account(null, { env: { OLLAMA_API_KEY: "env-key" } }));
      yield* readOnce(account("stored-key", { env: { OLLAMA_API_KEY: "env-key" } }));
      assert.deepStrictEqual(
        api.requests.map((request) => request.headers["authorization"]),
        ["Bearer env-key", "Bearer stored-key"],
      );
    }).pipe(Effect.provide(api.layer));
  });
});

describe("Ollama Cloud rate limits", () => {
  it.effect("waits out the Retry-After of a throttled balance, then asks again", () => {
    const api = ollamaApi({ "/api/balance": throttled(600) });
    const balanceReads = () => api.paths().length;
    return Effect.gen(function* () {
      const probe = yield* makeOllamaCloudUsageLimits(account());
      const first = yield* probe;
      assert.strictEqual(first.unavailable?.reason, "probeFailed");
      assert.isDefined(first.credentialFingerprint);

      yield* TestClock.adjust("9 minutes");
      const waiting = yield* probe;
      assert.strictEqual(waiting.unavailable?.reason, "probeFailed");
      assert.strictEqual(waiting.credentialFingerprint, first.credentialFingerprint);
      assert.strictEqual(balanceReads(), 1);

      api.routes["/api/balance"] = BALANCE;
      yield* TestClock.adjust("1 minute");
      const again = yield* probe;
      assert.strictEqual(balanceReads(), 2);
      assert.isUndefined(again.unavailable);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("holds off for a minute when it is throttled without being told how long", () => {
    const api = ollamaApi({ "/api/balance": throttled() });
    return Effect.gen(function* () {
      const probe = yield* makeOllamaCloudUsageLimits(account());
      yield* probe;
      yield* TestClock.adjust("59 seconds");
      yield* probe;
      assert.strictEqual(api.paths().length, 1);
      yield* TestClock.adjust("1 second");
      yield* probe;
      assert.strictEqual(api.paths().length, 2);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("asks again for a different key at once", () => {
    const api = ollamaApi({ "/api/balance": throttled(600) });
    return Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = {};
      const probe = yield* makeOllamaCloudUsageLimits({
        enabled: true,
        serverUrl: "",
        environment,
      });
      for (const key of ["first-key", "second-key"]) {
        environment.OPENCODE_AUTH_CONTENT = encodeJson({ "ollama-cloud": { type: "api", key } });
        yield* probe;
      }
      assert.strictEqual(api.paths().length, 2);
    }).pipe(Effect.provide(api.layer));
  });
});

describe("Ollama Cloud credit value", () => {
  const poolBalance = {
    included: { ...BALANCE.included, allowance_usd: 60, balance_usd: 41.2 },
    purchased: { balance_usd: 0 },
  };

  it.effect("prices the period's usage per model, from the days it holds whole", () => {
    const api = ollamaApi({ "/api/balance": poolBalance, "/api/usage": USAGE });
    const market = valuation(9.1);
    return Effect.gen(function* () {
      const limits = yield* readOnce(account());
      assert.strictEqual(limits.credit?.openRouterValueUsd, 9.1);
      assert.isUndefined(limits.credit?.purchasedBalanceUsd);
      assert.strictEqual(limits.credit?.planPriceUsd, 20);
      assert.deepStrictEqual(api.paths(), ["/api/balance", "/api/usage"]);
      assert.deepStrictEqual(UrlParams.toRecord(api.requests[1]!.urlParams), {
        range: "30d",
        group_by: "model",
      });
      assert.strictEqual(api.requests[1]?.headers["authorization"], "Bearer ollama-key");
      assert.deepStrictEqual(
        market.inputs.map(({ usedUsd, models, remainderUsageUsd }) => ({
          usedUsd: Number(usedUsd.toFixed(6)),
          remainderUsageUsd: Number(remainderUsageUsd.toFixed(6)),
          models: models.map((entry) => ({
            ...entry,
            usageUsd: Number(entry.usageUsd.toFixed(6)),
          })),
        })),
        [
          {
            usedUsd: 18.8,
            // Only one bucket in the period has a remainder group.
            remainderUsageUsd: 0.001,
            models: [
              {
                model: "glm-5.3-flash",
                usageUsd: 0.0132,
                inputTokens: 96000,
                cachedInputTokens: 60000,
                outputTokens: 12000,
              },
              {
                model: "glm-5.3",
                usageUsd: 0.01,
                inputTokens: 4000,
                cachedInputTokens: 0,
                outputTokens: 1000,
              },
              {
                model: "gpt-oss:120b",
                usageUsd: 0.0036,
                inputTokens: 16000,
                cachedInputTokens: 0,
                outputTokens: 2000,
              },
            ],
          },
        ],
      );
    }).pipe(Effect.provide(Layer.merge(api.layer, market.layer)));
  });

  it.effect("reads the history at most every ten minutes", () => {
    const api = ollamaApi({ "/api/balance": poolBalance, "/api/usage": USAGE });
    const market = valuation(9.1);
    const historyReads = () => api.paths().filter((path) => path === "/api/usage").length;
    return Effect.gen(function* () {
      const probe = yield* makeOllamaCloudUsageLimits(account());
      yield* probe;
      yield* TestClock.adjust("9 minutes");
      const cached = yield* probe;
      assert.strictEqual(historyReads(), 1);
      assert.strictEqual(cached.credit?.openRouterValueUsd, 9.1);
      yield* TestClock.adjust("1 minute");
      yield* probe;
      assert.strictEqual(historyReads(), 2);
      assert.strictEqual(api.paths().filter((path) => path === "/api/balance").length, 3);
    }).pipe(Effect.provide(Layer.merge(api.layer, market.layer)));
  });

  it.effect("starts over when the key changes", () => {
    const api = ollamaApi({ "/api/balance": poolBalance, "/api/usage": USAGE });
    const market = valuation(9.1);
    return Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = {};
      const probe = yield* makeOllamaCloudUsageLimits({
        enabled: true,
        serverUrl: "",
        environment,
      });
      for (const key of ["first-key", "second-key"]) {
        environment.OPENCODE_AUTH_CONTENT = encodeJson({ "ollama-cloud": { type: "api", key } });
        yield* probe;
      }
      assert.strictEqual(api.paths().filter((path) => path === "/api/usage").length, 2);
    }).pipe(Effect.provide(Layer.merge(api.layer, market.layer)));
  });

  it.effect("leaves the value out when the history or the valuation fails", () =>
    Effect.gen(function* () {
      const failing = ollamaApi({ "/api/balance": poolBalance, "/api/usage": 429 });
      const unpriced = ollamaApi({ "/api/balance": poolBalance, "/api/usage": USAGE });
      const noHistory = yield* readOnce(account()).pipe(
        Effect.provide(Layer.merge(failing.layer, valuation(9.1).layer)),
      );
      const noPrices = yield* readOnce(account()).pipe(
        Effect.provide(Layer.merge(unpriced.layer, valuation(undefined).layer)),
      );
      for (const limits of [noHistory, noPrices]) {
        assert.isUndefined(limits.unavailable);
        assert.strictEqual(limits.credit?.balanceUsd, 41.2);
        assert.isUndefined(limits.credit?.openRouterValueUsd);
      }
    }),
  );

  it.effect("leaves out the day the period began in, which also holds usage from before it", () => {
    // Renewed at 09:30 on the 15th: $30 on a priced model that morning, $1 on another since.
    const api = ollamaApi({
      "/api/balance": poolBalance,
      "/api/usage": {
        buckets: [
          {
            from: "2026-09-15T00:00:00Z",
            until: "2026-09-16T00:00:00Z",
            groups: [group("glm-5.3", 30, 1_000_000, 0, 100_000)],
          },
          {
            from: "2026-09-16T00:00:00Z",
            until: "2026-09-16T12:00:00Z",
            groups: [group("unlisted", 1, 1000, 0, 100)],
          },
        ],
      },
    });
    const market = valuation(9.1);
    return Effect.gen(function* () {
      yield* readOnce(account());
      assert.deepStrictEqual(
        market.inputs.flatMap((input) => input.models.map((entry) => entry.model)),
        ["unlisted"],
      );
    }).pipe(Effect.provide(Layer.merge(api.layer, market.layer)));
  });

  it.effect(
    "values only a personal plan's pool, since the balance does not say whose any other is",
    () =>
      Effect.gen(function* () {
        for (const allowance of [1000, 2000, 100]) {
          const api = ollamaApi({
            "/api/balance": {
              included: {
                ...poolBalance.included,
                allowance_usd: allowance,
                balance_usd: allowance * 0.8,
              },
            },
            "/api/usage": USAGE,
          });
          const market = valuation(9.1);
          const limits = yield* readOnce(account()).pipe(
            Effect.provide(Layer.merge(api.layer, market.layer)),
          );
          assert.strictEqual(limits.credit?.allowanceUsd, allowance);
          assert.isUndefined(limits.credit?.openRouterValueUsd);
          assert.deepStrictEqual(api.paths(), ["/api/balance"]);
          assert.deepStrictEqual(market.inputs, []);
        }
      }),
  );

  it.effect("keeps the last good history through a failed read, and waits out Retry-After", () => {
    const api = ollamaApi({ "/api/balance": poolBalance, "/api/usage": USAGE });
    const market = valuation(9.1);
    const historyReads = () => api.paths().filter((path) => path === "/api/usage").length;
    return Effect.gen(function* () {
      const probe = yield* makeOllamaCloudUsageLimits(account());
      yield* probe;
      assert.strictEqual(historyReads(), 1);

      yield* TestClock.adjust("11 minutes");
      api.routes["/api/usage"] = throttled(300);
      const during = yield* probe;
      // The read failed, but the history from before still prices the period.
      assert.strictEqual(historyReads(), 2);
      assert.strictEqual(during.credit?.openRouterValueUsd, 9.1);
      assert.strictEqual(market.inputs.length, 2);
      assert.deepStrictEqual(market.inputs[1]?.models, market.inputs[0]?.models);

      yield* TestClock.adjust("4 minutes");
      yield* probe;
      assert.strictEqual(historyReads(), 2);
      yield* TestClock.adjust("1 minute");
      api.routes["/api/usage"] = USAGE;
      yield* probe;
      assert.strictEqual(historyReads(), 3);
    }).pipe(Effect.provide(Layer.merge(api.layer, market.layer)));
  });

  it.effect("treats a stalled history read as a failure: the last good history stands", () => {
    const api = ollamaApi({ "/api/balance": poolBalance, "/api/usage": USAGE });
    const market = valuation(9.1);
    const historyReads = () => api.paths().filter((path) => path === "/api/usage").length;
    return Effect.gen(function* () {
      const probe = yield* makeOllamaCloudUsageLimits(account());
      yield* probe;

      yield* TestClock.adjust("11 minutes");
      api.stalled.add("/api/usage");
      const stalling = yield* probe.pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const during = yield* Fiber.join(stalling);
      assert.strictEqual(historyReads(), 2);
      assert.strictEqual(during.credit?.openRouterValueUsd, 9.1);

      // The stall counts like any failed read: nothing is asked again for a minute.
      yield* probe;
      assert.strictEqual(historyReads(), 2);
      api.stalled.delete("/api/usage");
      yield* TestClock.adjust("1 minute");
      yield* probe;
      assert.strictEqual(historyReads(), 3);
    }).pipe(Effect.provide(Layer.merge(api.layer, market.layer)));
  });

  it.effect("does not ask for the history before any credit is used", () => {
    const api = ollamaApi({
      "/api/balance": { included: { ...poolBalance.included, balance_usd: 60 } },
      "/api/usage": USAGE,
    });
    return Effect.gen(function* () {
      const limits = yield* readOnce(account());
      assert.strictEqual(limits.credit?.allowanceUsd, 60);
      assert.deepStrictEqual(api.paths(), ["/api/balance"]);
    }).pipe(Effect.provide(Layer.merge(api.layer, valuation(0).layer)));
  });
});

describe("makeOllamaCloudUsageLimits identity", () => {
  // sha256("ollama-cloud\0ollama-key") as node:crypto computed it; the bytes must never change,
  // or every Ollama Cloud account changes identity.
  const ollamaKeyFingerprint = "38b5c6edc2d3c57c9df3e1fb6fa38aac1a1bbe28c0bf4be43192e811618c0521";

  it.effect("publishes a per-key fingerprint and never the key itself", () => {
    const api = ollamaApi({ "/api/balance": BALANCE });
    return Effect.gen(function* () {
      const first = yield* readOnce(account("ollama-key"));
      const other = yield* readOnce(account("another-key"));
      assert.strictEqual(first.credentialFingerprint, ollamaKeyFingerprint);
      assert.notStrictEqual(other.credentialFingerprint, first.credentialFingerprint);
      assert.notInclude(encodeJson(first), "ollama-key");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("keeps the fingerprint when the call fails", () => {
    const ok = ollamaApi({ "/api/balance": BALANCE });
    const down = ollamaApi({ "/api/balance": 500 });
    return Effect.gen(function* () {
      const healthy = yield* readOnce(account()).pipe(Effect.provide(ok.layer));
      const failed = yield* readOnce(account()).pipe(Effect.provide(down.layer));
      assert.strictEqual(failed.unavailable?.reason, "probeFailed");
      assert.strictEqual(failed.unavailable?.message, "Ollama Cloud could not read usage.");
      assert.isDefined(failed.credentialFingerprint);
      assert.strictEqual(failed.credentialFingerprint, healthy.credentialFingerprint);
      assert.notInclude(encodeJson(failed), "ollama-key");
    });
  });

  it.effect("fails the probe when Ollama refuses the key or throttles the call", () =>
    Effect.gen(function* () {
      for (const status of [401, 429, 503]) {
        const limits = yield* readOnce(account()).pipe(
          Effect.provide(ollamaApi({ "/api/balance": status }).layer),
        );
        assert.strictEqual(limits.unavailable?.reason, "probeFailed");
      }
    }),
  );

  it.effect("gives up on a stalled key read, without a fingerprint", () =>
    Effect.gen(function* () {
      const probe = yield* makeOllamaCloudUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: { HOME: "/home/nobody" },
      });
      const fiber = yield* probe.pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const limits = yield* Fiber.join(fiber);
      assert.strictEqual(limits.unavailable?.reason, "probeFailed");
      assert.strictEqual(limits.credentialFingerprint, undefined);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ readFileString: () => Effect.never }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("must not reach Ollama")),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
});
