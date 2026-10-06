import * as NodeCrypto from "node:crypto";

import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { readOllamaCloudUsageLimits } from "./ollamaCloudUsageLimits.ts";

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

/** Answers every request with `body` (or a bare status) and records them. */
function ollamaApi(response: unknown | number) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            typeof response === "number"
              ? new Response(null, { status: response })
              : Response.json(response),
          ),
        );
      }),
    ),
  );
  return { layer, requests };
}

const summary = (limits: ServerProviderUsageLimits) =>
  limits.windows.map((window) => [window.id, window.kind, window.usedPercent]);

describe("readOllamaCloudUsageLimits", () => {
  it.effect("maps a monthly-pool response and sends the key as a bearer token", () => {
    const api = ollamaApi({
      activity: { requests: 3 },
      limits: { monthly: { usage: 0.001, models: [{ name: "glm-5", requests: 2 }] } },
    });
    return Effect.gen(function* () {
      const limits = yield* readOllamaCloudUsageLimits(account());
      assert.deepStrictEqual(summary(limits), [["ollama_monthly", "monthly", 0.1]]);
      assert.strictEqual(limits.windows[0]?.label, "Ollama · Monthly");
      assert.isUndefined(limits.windows[0]?.resetsAt);
      assert.isUndefined(limits.unavailable);
      assert.strictEqual(api.requests.length, 1);
      assert.strictEqual(api.requests[0]?.url, "https://ollama.com/api/usage");
      assert.strictEqual(api.requests[0]?.headers["authorization"], "Bearer ollama-key");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("maps the session and weekly windows of an older plan", () => {
    const api = ollamaApi({ limits: { session: { usage: 0.025 }, weekly: { usage: 0.5 } } });
    return Effect.gen(function* () {
      const limits = yield* readOllamaCloudUsageLimits(account());
      assert.deepStrictEqual(summary(limits), [
        ["ollama_session", "session", 2.5],
        ["ollama_weekly", "weekly", 50],
      ]);
      assert.strictEqual(limits.windows[0]?.windowDurationMins, 5 * 60);
      assert.strictEqual(limits.windows[1]?.windowDurationMins, 7 * 24 * 60);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("decodes per-model counts shaped as an array or as an object", () => {
    const api = ollamaApi({
      limits: {
        session: { usage: 0.1, models: [{ name: "glm-5", requests: 1 }] },
        weekly: { usage: 0.2, models: { "glm-5": { requests: 1 } } },
      },
    });
    return Effect.gen(function* () {
      const limits = yield* readOllamaCloudUsageLimits(account());
      assert.deepStrictEqual(
        limits.windows.map((window) => window.id),
        ["ollama_session", "ollama_weekly"],
      );
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("clamps usage above the plan", () => {
    const api = ollamaApi({ limits: { monthly: { usage: 1.2 } } });
    return Effect.gen(function* () {
      const limits = yield* readOllamaCloudUsageLimits(account());
      assert.strictEqual(limits.windows[0]?.usedPercent, 100);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("is unsupported without a key and never calls Ollama", () => {
    const api = ollamaApi({});
    return Effect.gen(function* () {
      const limits = yield* readOllamaCloudUsageLimits(account(null));
      assert.strictEqual(limits.unavailable?.reason, "unsupported");
      assert.isUndefined(limits.credentialFingerprint);
      assert.strictEqual(api.requests.length, 0);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("never calls Ollama when disabled or pointed at an external server", () => {
    const api = ollamaApi({ limits: { monthly: { usage: 0.5 } } });
    return Effect.gen(function* () {
      for (const input of [
        account("ollama-key", { enabled: false }),
        account("ollama-key", { serverUrl: "http://remote.example:4096" }),
      ]) {
        const limits = yield* readOllamaCloudUsageLimits(input);
        assert.strictEqual(limits.unavailable?.reason, "unsupported");
      }
      assert.strictEqual(api.requests.length, 0);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("is unsupported when the response has no known window or the plan is refused", () => {
    const empty = ollamaApi({ activity: {}, limits: {} });
    const refused = ollamaApi(403);
    return Effect.gen(function* () {
      const none = yield* readOllamaCloudUsageLimits(account()).pipe(Effect.provide(empty.layer));
      const forbidden = yield* readOllamaCloudUsageLimits(account()).pipe(
        Effect.provide(refused.layer),
      );
      assert.strictEqual(none.unavailable?.reason, "unsupported");
      assert.strictEqual(forbidden.unavailable?.reason, "unsupported");
    });
  });

  it.effect("falls back to OLLAMA_API_KEY, but a stored key wins", () => {
    const api = ollamaApi({ limits: { monthly: { usage: 0.5 } } });
    return Effect.gen(function* () {
      yield* readOllamaCloudUsageLimits(account(null, { env: { OLLAMA_API_KEY: "env-key" } }));
      yield* readOllamaCloudUsageLimits(
        account("stored-key", { env: { OLLAMA_API_KEY: "env-key" } }),
      );
      assert.deepStrictEqual(
        api.requests.map((request) => request.headers["authorization"]),
        ["Bearer env-key", "Bearer stored-key"],
      );
    }).pipe(Effect.provide(api.layer));
  });
});

describe("readOllamaCloudUsageLimits identity", () => {
  const sha256 = (...parts: string[]) =>
    parts.reduce((hash, part) => hash.update(part), NodeCrypto.createHash("sha256")).digest("hex");

  it.effect("publishes a per-key fingerprint and never the key itself", () => {
    const api = ollamaApi({ limits: { monthly: { usage: 0.5 } } });
    return Effect.gen(function* () {
      const first = yield* readOllamaCloudUsageLimits(account("ollama-key"));
      const other = yield* readOllamaCloudUsageLimits(account("another-key"));
      assert.strictEqual(first.credentialFingerprint, sha256("ollama-cloud\0", "ollama-key"));
      assert.notStrictEqual(other.credentialFingerprint, first.credentialFingerprint);
      assert.notInclude(encodeJson(first), "ollama-key");
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("keeps the fingerprint when the call fails", () => {
    const ok = ollamaApi({ limits: { monthly: { usage: 0.5 } } });
    const down = ollamaApi(500);
    return Effect.gen(function* () {
      const healthy = yield* readOllamaCloudUsageLimits(account()).pipe(Effect.provide(ok.layer));
      const failed = yield* readOllamaCloudUsageLimits(account()).pipe(Effect.provide(down.layer));
      assert.strictEqual(failed.unavailable?.reason, "probeFailed");
      assert.strictEqual(failed.unavailable?.message, "Ollama Cloud could not read usage.");
      assert.isDefined(failed.credentialFingerprint);
      assert.strictEqual(failed.credentialFingerprint, healthy.credentialFingerprint);
      assert.notInclude(encodeJson(failed), "ollama-key");
    });
  });

  it.effect("gives up on a stalled key read, without a fingerprint", () =>
    Effect.gen(function* () {
      const fiber = yield* readOllamaCloudUsageLimits({
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
        HttpClient.make(() => Effect.die("must not reach Ollama")),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
});
