import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeSubscriptionUsageLimits } from "./subscriptionUsageLimits.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const account = () => ({
  driver: ProviderDriverKind.make("opencode"),
  instanceId: ProviderInstanceId.make("opencode"),
  enabled: true,
  serverUrl: "",
  // Only Unlid has a credential: the Go, Z.ai and Ollama probes stay unsupported.
  environment: {
    OPENCODE_AUTH_CONTENT: encodeJson({ unlid: { type: "api", key: "unlid-key" } }),
  },
});

/** Answers each path a probe calls with its body (500 when none is routed) and records the requests. */
function probesApi(routes: Readonly<Record<string, unknown>>) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
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
  );
  return { layer, requests };
}

describe("makeSubscriptionUsageLimits", () => {
  it.effect("wires the Unlid probe's balance into the account's subscriptions", () => {
    const api = probesApi({ "/v1/me": { balance_usd: 4.99 } });
    return Effect.gen(function* () {
      const { usageLimits } = yield* makeSubscriptionUsageLimits(account());
      const combined = yield* usageLimits;
      assert.deepStrictEqual(
        combined.subscriptions?.map(({ id, label, windowIds, balance }) => ({
          id,
          label,
          windowIds,
          balance,
        })),
        [{ id: "unlid", label: "Unlid", windowIds: [], balance: { balanceUsd: 4.99 } }],
      );
      assert.deepStrictEqual(combined.windows, []);
      // Only Unlid holds a credential here, so only its probe called out.
      assert.deepStrictEqual(
        api.requests.map((request) => new URL(request.url).pathname),
        ["/v1/me"],
      );
    }).pipe(Effect.provide(api.layer));
  });
});
