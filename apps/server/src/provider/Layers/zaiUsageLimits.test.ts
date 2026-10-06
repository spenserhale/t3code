import * as NodeCrypto from "node:crypto";

import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { makeUnavailableUsageLimits, makeUsageLimits } from "../providerUsageLimits.ts";
import {
  combineUsageLimits,
  consumeZaiResetCredit,
  keepLastGoodUsageLimits,
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

describe("readZaiCodingPlanUsageLimits identity", () => {
  const sha256 = (...parts: string[]) =>
    parts.reduce((hash, part) => hash.update(part), NodeCrypto.createHash("sha256")).digest("hex");

  it.effect("publishes a per-key fingerprint and never the key itself", () => {
    const api = zaiApi({ [QUOTA]: quota(3, 6), [RESET_LIST]: resets([], []) });
    return Effect.gen(function* () {
      const first = yield* readZaiCodingPlanUsageLimits(account("zai-key"));
      const again = yield* readZaiCodingPlanUsageLimits(account("zai-key"));
      const other = yield* readZaiCodingPlanUsageLimits(account("another-key"));
      assert.strictEqual(first.credentialFingerprint, sha256("zai-coding-plan\0", "zai-key"));
      assert.strictEqual(again.credentialFingerprint, first.credentialFingerprint);
      assert.notStrictEqual(other.credentialFingerprint, first.credentialFingerprint);
      assert.notInclude(encodeJson(first), "zai-key");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("keeps the fingerprint when the quota call fails", () => {
    const ok = zaiApi({ [QUOTA]: quota(3, 6), [RESET_LIST]: resets([], []) });
    const down = zaiApi({});
    return Effect.gen(function* () {
      const healthy = yield* readZaiCodingPlanUsageLimits(account()).pipe(Effect.provide(ok.layer));
      const failed = yield* readZaiCodingPlanUsageLimits(account()).pipe(
        Effect.provide(down.layer),
      );
      assert.strictEqual(failed.unavailable?.reason, "probeFailed");
      assert.strictEqual(failed.unavailable?.message, "Z.ai could not read Coding Plan usage.");
      assert.isDefined(failed.credentialFingerprint);
      assert.strictEqual(failed.credentialFingerprint, healthy.credentialFingerprint);
    });
  });

  it.effect("gives up on a stalled key read, without a fingerprint", () =>
    Effect.gen(function* () {
      const fiber = yield* readZaiCodingPlanUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: { HOME: "/home/nobody" },
      }).pipe(Effect.forkChild);
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
        HttpClient.make(() => Effect.die("must not reach Z.ai")),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("publishes no fingerprint without a key", () => {
    const api = zaiApi({});
    return Effect.gen(function* () {
      const limits = yield* readZaiCodingPlanUsageLimits(account(null));
      assert.strictEqual(limits.unavailable?.reason, "unsupported");
      assert.strictEqual(limits.credentialFingerprint, undefined);
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

  it("is as old as the oldest result it was built from", () => {
    const older = "2026-09-19T23:00:00.000Z";
    const remembered = { ...zai, checkedAt: older };
    const live = makeUsageLimits({
      checkedAt,
      windows: [{ id: "go_weekly", kind: "weekly", label: "Go · Weekly", usedPercent: 2 }],
    });
    assert.strictEqual(combineUsageLimits([live, remembered]).checkedAt, older);
    assert.strictEqual(combineUsageLimits([remembered, live]).checkedAt, older);
    assert.strictEqual(combineUsageLimits([live, failed]).checkedAt, checkedAt);
  });

  it("reports a failure over unsupported when nothing answered", () => {
    assert.strictEqual(combineUsageLimits([unsupported, failed]), failed);
    assert.strictEqual(combineUsageLimits([unsupported, unsupported]), unsupported);
  });

  describe("account identity", () => {
    const withFingerprint = (
      limits: ReturnType<typeof makeUsageLimits>,
      credentialFingerprint: string,
    ) => ({ ...limits, credentialFingerprint });
    const go = withFingerprint(
      makeUsageLimits({
        checkedAt,
        windows: [{ id: "go_weekly", kind: "weekly", label: "Go · Weekly", usedPercent: 2 }],
      }),
      "go-fingerprint",
    );
    const zaiIdentified = withFingerprint(zai, "zai-fingerprint");
    const zaiFailed = {
      ...makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message: "down" }),
      credentialFingerprint: "zai-fingerprint",
    };

    it("keeps a single subscription's fingerprint unchanged", () => {
      assert.strictEqual(
        combineUsageLimits([unsupported, zaiIdentified]).credentialFingerprint,
        "zai-fingerprint",
      );
      assert.strictEqual(
        combineUsageLimits([go, unsupported]).credentialFingerprint,
        "go-fingerprint",
      );
    });

    it("names the account by both credentials, whatever the order", () => {
      const both = combineUsageLimits([go, zaiIdentified]).credentialFingerprint;
      assert.isDefined(both);
      assert.strictEqual(combineUsageLimits([zaiIdentified, go]).credentialFingerprint, both);
      assert.notStrictEqual(both, "go-fingerprint");
      assert.notStrictEqual(both, "zai-fingerprint");
    });

    it("does not lose the account when one probe fails", () => {
      assert.strictEqual(
        combineUsageLimits([go, zaiFailed]).credentialFingerprint,
        combineUsageLimits([go, zaiIdentified]).credentialFingerprint,
      );
    });

    it("publishes no fingerprint when no credential has one", () => {
      assert.strictEqual(combineUsageLimits([zai, unsupported]).credentialFingerprint, undefined);
    });

    it.effect(
      "keeps a subscription's bars and the account's identity through one failed check",
      () =>
        Effect.gen(function* () {
          const goFailed = makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "down",
          });
          const goReads = [go, goFailed];
          const readGo = yield* keepLastGoodUsageLimits(Effect.sync(() => goReads.shift() ?? go));
          const readZai = yield* keepLastGoodUsageLimits(Effect.succeed(zaiIdentified));
          const refresh = () =>
            Effect.all([readGo, readZai]).pipe(Effect.map(([a, b]) => combineUsageLimits([a, b])));

          const healthy = yield* refresh();
          const afterFailure = yield* refresh();
          assert.deepStrictEqual(
            afterFailure.windows.map((window) => window.id),
            ["go_weekly", "zai_weekly"],
          );
          assert.isDefined(healthy.credentialFingerprint);
          assert.strictEqual(afterFailure.credentialFingerprint, healthy.credentialFingerprint);
        }),
    );
  });
});

describe("keepLastGoodUsageLimits", () => {
  const checkedAt = "2026-09-20T00:00:00.000Z";
  const good = makeUsageLimits({
    checkedAt,
    windows: [{ id: "zai_weekly", kind: "weekly", label: "Z.ai · Weekly", usedPercent: 6 }],
  });
  const failed = makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message: "down" });
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });

  const withFingerprint = (limits: ServerProviderUsageLimits, credentialFingerprint: string) => ({
    ...limits,
    credentialFingerprint,
  });

  const run = (reads: readonly ServerProviderUsageLimits[]) =>
    Effect.gen(function* () {
      const remaining = [...reads];
      const probe = yield* keepLastGoodUsageLimits(
        Effect.sync(() => remaining.shift() as ServerProviderUsageLimits),
      );
      return yield* Effect.all(reads.map(() => probe));
    });

  it.effect("returns the last good result when a later read fails", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run([good, failed, failed]), [good, good, good]);
    }),
  );

  it.effect("lets unsupported replace what it remembered", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run([good, unsupported]), [good, unsupported]);
    }),
  );

  it.effect("reports a failure when nothing good was remembered", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* run([failed]), [failed]);
    }),
  );

  it.effect("publishes a failure that names a different credential", () =>
    Effect.gen(function* () {
      const goodA = withFingerprint(good, "key-a");
      const failedB = withFingerprint(failed, "key-b");
      assert.deepStrictEqual(yield* run([goodA, failedB, failedB]), [goodA, failedB, failedB]);
    }),
  );

  it.effect("keeps the last good result when the failure names the same credential", () =>
    Effect.gen(function* () {
      const goodA = withFingerprint(good, "key-a");
      assert.deepStrictEqual(yield* run([goodA, withFingerprint(failed, "key-a")]), [goodA, goodA]);
    }),
  );

  it.effect("keeps the last good result when the failure names no credential", () =>
    Effect.gen(function* () {
      const goodA = withFingerprint(good, "key-a");
      assert.deepStrictEqual(yield* run([goodA, failed]), [goodA, goodA]);
    }),
  );
});
