import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeUnavailableUsageLimits, makeUsageLimits } from "../providerUsageLimits.ts";
import {
  combineUsageLimits,
  consumeZaiResetCredit,
  readZaiCodingPlanUsageLimits,
} from "./zaiUsageLimits.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const account = (key: string | null = "zai-key") => ({
  enabled: true,
  serverUrl: "",
  environment: {
    OPENCODE_AUTH_CONTENT: encodeJson(key ? { "zai-coding-plan": { type: "api", key } } : {}),
  },
});

const quota = (fiveHour: number, weekly: number) => ({
  success: true,
  data: {
    level: "max",
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: fiveHour,
        nextResetTime: 1789981321939,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        number: 1,
        percentage: weekly,
        nextResetTime: 1790215220983,
      },
      { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, nextResetTime: 1792461620999 },
      { type: "SOMETHING_NEW", unit: 9, number: 1, percentage: 50 },
    ],
  },
});

const resets = (fiveHour: readonly number[], week: readonly number[]) => ({
  success: true,
  data: {
    fiveHourResets: fiveHour.map((recordId) => ({
      recordId,
      expireTime: "2026-10-01 23:59:59",
      available: true,
    })),
    weekResets: [
      { recordId: 1, expireTime: "2026-09-01 23:59:59", available: false },
      ...week.map((recordId) => ({ recordId, expireTime: "2026-10-01 23:59:59", available: true })),
    ],
  },
});

/** Routes by pathname and records every request, so tests can prove what was never sent. */
function zaiApi(routes: Readonly<Record<string, unknown>>) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request);
        const body = routes[new URL(request.url).pathname];
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            body === undefined ? new Response(null, { status: 500 }) : Response.json(body),
          ),
        );
      }),
    ),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(7),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  return { layer, requests };
}

const QUOTA = "/api/monitor/usage/quota/limit";
const RESET_LIST = "/api/biz/customer-package-reset/list";
const RESET_USE = "/api/biz/customer-package-reset/use";

describe("readZaiCodingPlanUsageLimits", () => {
  it.effect("maps the quota windows and offers the reset for the fuller window", () => {
    const api = zaiApi({ [QUOTA]: quota(3, 6), [RESET_LIST]: resets([11], [22]) });
    return Effect.gen(function* () {
      const limits = yield* readZaiCodingPlanUsageLimits(account());
      assert.deepStrictEqual(
        limits.windows.map((window) => [window.id, window.kind, window.usedPercent]),
        [
          ["zai_five_hour", "session", 3],
          ["zai_weekly", "weekly", 6],
          ["zai_tools_monthly", "monthly", 0],
        ],
      );
      assert.strictEqual(limits.windows[0]?.resetsAt, "2026-09-21T09:02:01.939Z");
      assert.deepStrictEqual(limits.resetCredits, {
        availableCount: 2,
        nextCreditId: "WEEK:22",
        nextExpiresAt: "2026-10-01T15:59:59.000Z",
      });
      // Z.ai rejects a `Bearer` prefix.
      assert.strictEqual(api.requests[0]?.headers["authorization"], "zai-key");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("is unsupported without a Coding Plan key and never calls Z.ai", () => {
    const api = zaiApi({});
    return Effect.gen(function* () {
      const limits = yield* readZaiCodingPlanUsageLimits(account(null));
      assert.strictEqual(limits.unavailable?.reason, "unsupported");
      assert.strictEqual(api.requests.length, 0);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("treats a 200 response with success false as a failed probe", () => {
    const api = zaiApi({ [QUOTA]: { success: false, code: 401, msg: "token expired" } });
    return Effect.gen(function* () {
      const limits = yield* readZaiCodingPlanUsageLimits(account());
      assert.strictEqual(limits.unavailable?.reason, "probeFailed");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("keeps the quota bars when the reset list is down", () => {
    const api = zaiApi({ [QUOTA]: quota(40, 10) });
    return Effect.gen(function* () {
      const limits = yield* readZaiCodingPlanUsageLimits(account());
      assert.strictEqual(limits.windows.length, 3);
      assert.strictEqual(limits.resetCredits, undefined);
    }).pipe(Effect.provide(api.layer));
  });
});

describe("consumeZaiResetCredit", () => {
  it.effect("spends the 5-hour reset when that window is the fuller one", () => {
    const api = zaiApi({
      [QUOTA]: quota(90, 20),
      [RESET_LIST]: resets([11], [22]),
      [RESET_USE]: { success: true },
    });
    return Effect.gen(function* () {
      assert.strictEqual(yield* consumeZaiResetCredit(account()), "reset");
      const use = api.requests.find((request) => request.url.endsWith(RESET_USE));
      assert.strictEqual(use?.method, "POST");
      assert.strictEqual(use?.headers["authorization"], "zai-key");
      const body = use?.body._tag === "Uint8Array" ? new TextDecoder().decode(use.body.body) : "";
      assert.include(body, '"resetType":"FIVE_HOUR"');
      assert.include(body, '"recordId":11');
      assert.include(body, '"targetType":"PERSONAL"');
      assert.match(body, /"requestId":"[0-9a-f-]{36}"/);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("spends nothing when no reset is banked or nothing has been used", () => {
    const noCredit = zaiApi({ [QUOTA]: quota(90, 20), [RESET_LIST]: resets([], []) });
    const unused = zaiApi({ [QUOTA]: quota(0, 0), [RESET_LIST]: resets([], [22]) });
    return Effect.gen(function* () {
      assert.strictEqual(
        yield* consumeZaiResetCredit(account()).pipe(Effect.provide(noCredit.layer)),
        "noCredit",
      );
      assert.strictEqual(
        yield* consumeZaiResetCredit(account()).pipe(Effect.provide(unused.layer)),
        "nothingToReset",
      );
      for (const api of [noCredit, unused]) {
        assert.isFalse(api.requests.some((request) => request.method === "POST"));
      }
    });
  });

  it.effect("fails with Z.ai's own reason when the reset is rejected", () => {
    const api = zaiApi({
      [QUOTA]: quota(10, 80),
      [RESET_LIST]: resets([], [22]),
      [RESET_USE]: { success: false, msg: "Reset already used this week" },
    });
    return Effect.gen(function* () {
      const error = yield* consumeZaiResetCredit(account()).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ZaiResetRejected");
      assert.include(error.message, "Reset already used this week");
    }).pipe(Effect.provide(api.layer));
  });
});

describe("combineUsageLimits", () => {
  const checkedAt = "2026-09-20T00:00:00.000Z";
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const failed = makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message: "down" });
  const zai = {
    ...makeUsageLimits({
      checkedAt,
      windows: [{ id: "zai_weekly", kind: "weekly", label: "Z.ai · Weekly", usedPercent: 6 }],
    }),
    resetCredits: { availableCount: 1, nextCreditId: "WEEK:22" },
  };

  it("shows the subscriptions that answered and keeps their reset credits", () => {
    assert.deepStrictEqual(combineUsageLimits([failed, zai]), zai);
  });

  it("reports a failure over unsupported when nothing answered", () => {
    assert.strictEqual(combineUsageLimits([unsupported, failed]), failed);
    assert.strictEqual(combineUsageLimits([unsupported, unsupported]), unsupported);
  });
});
