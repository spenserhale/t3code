import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readUnlidUsageLimits } from "./unlidUsageLimits.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const account = (key: string | null = "unlid-key", overrides: { readonly env?: object } = {}) => ({
  driver: ProviderDriverKind.make("opencode"),
  instanceId: ProviderInstanceId.make("opencode"),
  enabled: true,
  serverUrl: "",
  environment: {
    OPENCODE_AUTH_CONTENT: encodeJson(key ? { unlid: { type: "api", key } } : {}),
    ...overrides.env,
  },
});

// The fields of a paid-up `/v1/me` answer.
const ME_FULL = {
  name: "spenser",
  prefix: "ul-abc",
  balance_usd: 4.99,
  held_usd: 0.01,
  month_spend_usd: 14.82,
};

const ME = "/v1/me";

/** A body or a bare status. */
type Routes = Record<string, unknown>;

/** Answers each Unlid path with its body (or a bare status) and records the requests. */
function unlidApi(routes: Routes) {
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
              ? new Response(null, { status: 500 })
              : typeof response === "number"
                ? new Response(null, { status: response })
                : Response.json(response),
          ),
        );
      }),
    ),
  );
  return { layer, requests, routes, stalled };
}

// sha256("unlid\0unlid-key") as node:crypto computed it; the bytes must never change,
// or every Unlid account changes identity.
const UNLID_KEY_FINGERPRINT = "c0e7b58acc3977d028a7d6513512e6d99f9491ea0efccc5c28fbe8aabbf108e8";

describe("readUnlidUsageLimits", () => {
  it.effect("decodes the /v1/me balance and never names the key", () => {
    const api = unlidApi({ [ME]: ME_FULL });
    return Effect.gen(function* () {
      const limits = yield* readUnlidUsageLimits(account());
      assert.deepStrictEqual(limits.windows, []);
      assert.deepStrictEqual(limits.balance, {
        balanceUsd: 4.99,
        heldUsd: 0.01,
        monthSpendUsd: 14.82,
      });
      assert.deepStrictEqual(limits.externalUsage, {
        label: "Balance & billing",
        url: "https://unlid.ai/account/billing",
      });
      assert.strictEqual(limits.credentialFingerprint, UNLID_KEY_FINGERPRINT);
      assert.isUndefined(limits.unavailable);
      assert.strictEqual(api.requests[0]?.headers["authorization"], "Bearer unlid-key");
      assert.notInclude(JSON.stringify(limits), "unlid-key");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("decodes a /v1/me response that only names the balance", () => {
    const api = unlidApi({ [ME]: { balance_usd: 12 } });
    return Effect.gen(function* () {
      const limits = yield* readUnlidUsageLimits(account());
      assert.deepStrictEqual(limits.windows, []);
      assert.deepStrictEqual(limits.balance, { balanceUsd: 12 });
      assert.isUndefined(limits.unavailable);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("keeps the fingerprint when the probe fails", () => {
    const api = unlidApi({ [ME]: 500 });
    return Effect.gen(function* () {
      const limits = yield* readUnlidUsageLimits(account());
      assert.strictEqual(limits.unavailable?.reason, "probeFailed");
      assert.strictEqual(limits.credentialFingerprint, UNLID_KEY_FINGERPRINT);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("calls a 401 key rejected, and the message never names the key", () => {
    const api = unlidApi({ [ME]: 401 });
    return Effect.gen(function* () {
      const limits = yield* readUnlidUsageLimits(account());
      assert.strictEqual(limits.unavailable?.reason, "unsupported");
      assert.strictEqual(limits.unavailable?.message, "Unlid rejected the key.");
      assert.notInclude(JSON.stringify(limits), "unlid-key");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("calls a 403 key rejected", () => {
    const api = unlidApi({ [ME]: 403 });
    return Effect.gen(function* () {
      const limits = yield* readUnlidUsageLimits(account());
      assert.strictEqual(limits.unavailable?.reason, "unsupported");
      assert.strictEqual(limits.unavailable?.message, "Unlid rejected the key.");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("treats 402 as a valid key on an empty account", () => {
    const api = unlidApi({ [ME]: 402 });
    return Effect.gen(function* () {
      const limits = yield* readUnlidUsageLimits(account());
      assert.isUndefined(limits.unavailable);
      assert.deepStrictEqual(limits.balance, { balanceUsd: 0 });
      assert.strictEqual(limits.credentialFingerprint, UNLID_KEY_FINGERPRINT);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("gives up on a stalled probe", () => {
    const api = unlidApi({});
    api.stalled.add(ME);
    return Effect.gen(function* () {
      const fiber = yield* readUnlidUsageLimits(account()).pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      const limits = yield* Fiber.join(fiber);
      assert.strictEqual(limits.unavailable?.reason, "probeFailed");
      assert.strictEqual(limits.credentialFingerprint, UNLID_KEY_FINGERPRINT);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("reports a body without a balance as a failed probe", () => {
    const api = unlidApi({ [ME]: { name: "spenser", prefix: "ul-abc" } });
    return Effect.gen(function* () {
      const limits = yield* readUnlidUsageLimits(account());
      assert.strictEqual(limits.unavailable?.reason, "probeFailed");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("is unsupported without any key and never calls Unlid", () => {
    const api = unlidApi({ [ME]: ME_FULL });
    return Effect.gen(function* () {
      const limits = yield* readUnlidUsageLimits(account(null));
      assert.strictEqual(limits.unavailable?.reason, "unsupported");
      assert.isDefined(limits.unavailable?.message);
      assert.isUndefined(limits.credentialFingerprint);
      assert.strictEqual(api.requests.length, 0);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("falls back to UNLID_API_KEY, but a stored key wins", () => {
    const api = unlidApi({ [ME]: ME_FULL });
    return Effect.gen(function* () {
      yield* readUnlidUsageLimits(account(null, { env: { UNLID_API_KEY: "env-key" } }));
      yield* readUnlidUsageLimits(account("stored-key", { env: { UNLID_API_KEY: "env-key" } }));
      assert.deepStrictEqual(
        api.requests.map((request) => request.headers["authorization"]),
        ["Bearer env-key", "Bearer stored-key"],
      );
    }).pipe(Effect.provide(api.layer));
  });
});
