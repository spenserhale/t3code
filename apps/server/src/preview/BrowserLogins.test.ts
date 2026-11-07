import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Settings from "../serverSettings.ts";
import * as BrowserLogins from "./BrowserLogins.ts";
import { scrubSecrets } from "./ServerBrowserLogin.ts";

describe("loginCoversPage", () => {
  const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string, boolean]> = [
    [["https://grafana.example.com/login"], "https://grafana.example.com/d/abc", true],
    [["grafana.example.com"], "https://grafana.example.com/", true],
    [["https://example.com"], "https://eu.example.com/login", true],
    [["https://example.com"], "https://example.com.evil.test/login", false],
    [["https://example.com"], "https://notexample.com/", false],
    [["https://example.com"], "http://example.com/", false],
    [["http://legacy.local"], "http://legacy.local/", true],
    [["https://example.com:8443"], "https://example.com/", false],
    [["https://example.com:8443"], "https://example.com:8443/", true],
    [["https://example.com"], "about:blank", false],
    [["https://example.com"], "file:///etc/passwd", false],
    [["not a url"], "https://example.com/", false],
  ];
  it.each(cases)("%j on %s is %s", (urls, page, expected) => {
    assert.strictEqual(BrowserLogins.loginCoversPage(urls, page), expected);
  });
});

describe("scrubSecrets", () => {
  it("replaces filled secrets everywhere except image bytes", () => {
    const secrets = new Set(["hunter2", "123456"]);
    const scrubbed = scrubSecrets(
      {
        visibleText: "code 123456",
        consoleEntries: [{ text: "pw=hunter2" }],
        screenshot: { data: "aGVsbG8hunter2" },
        count: 3,
      },
      secrets,
    );
    assert.deepStrictEqual(scrubbed, {
      visibleText: "code [filled by password manager]",
      consoleEntries: [{ text: "pw=[filled by password manager]" }],
      screenshot: { data: "aGVsbG8hunter2" },
      count: 3,
    });
  });
});

const kind = SecretProviderKind.make("fake_vault");
const providerId = SecretProviderId.make("work");
const grafana = {
  id: "g1",
  title: "Grafana",
  vault: "Work",
  urls: ["https://grafana.example.com"],
};
const github = { id: "h1", title: "GitHub", urls: ["https://github.com"] };

const makeService = (listed: ReadonlyArray<typeof grafana | typeof github> | undefined) => {
  const calls = { list: 0 };
  const driver = defineSecretProviderDriver({
    kind,
    definition: defineSecretProvider({
      kind,
      label: "Fake Vault",
      configSchema: Schema.Struct({ account: Schema.String }),
      isReference: () => true,
      referencePlaceholder: "",
      invalidReferenceMessage: "",
      supportsLogins: true,
    }),
    read: (_config, references) => Effect.succeed(references.map(() => undefined)),
    logins: {
      list: () =>
        Effect.sync(() => {
          calls.list++;
          return listed;
        }),
      read: (_config, _login, fields) =>
        Effect.succeed(Object.fromEntries(fields.map((field) => [field, `${field}-value`]))),
    },
  });
  const layer = Layer.effect(BrowserLogins.BrowserLogins, BrowserLogins.make([driver])).pipe(
    Layer.provideMerge(
      Settings.layerTest({
        secretProviders: { [providerId]: { kind, label: "Work", config: { account: "me" } } },
        browserLogins: { secretProviderId: providerId, approval: "thread" },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { layer, calls };
};

describe("BrowserLogins", () => {
  it.effect("offers only logins for the page's site, listing once", () => {
    const { layer, calls } = makeService([grafana, github]);
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const first = yield* logins.candidates("https://grafana.example.com/login");
      assert.deepStrictEqual(first.logins, [grafana]);
      assert.strictEqual(first.provider.label, "Fake Vault");
      yield* logins.candidates("https://github.com/login");
      assert.strictEqual(calls.list, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails clearly when the provider cannot list", () => {
    const { layer } = makeService(undefined);
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const error = yield* logins.candidates("https://github.com/").pipe(Effect.flip);
      assert.strictEqual(error.reason, "unreadable");
    }).pipe(Effect.provide(layer));
  });

  it.effect("is off until a provider is chosen", () => {
    const { layer } = makeService([github]);
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ browserLogins: { approval: "thread" } });
      const logins = yield* BrowserLogins.BrowserLogins;
      const error = yield* logins.candidates("https://github.com/").pipe(Effect.flip);
      assert.strictEqual(error.reason, "not_configured");
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks once per thread, every time, or once for all threads", () => {
    const { layer } = makeService([github]);
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const setApproval = (approval: "request" | "thread" | "application") =>
        settings.updateSettings({ browserLogins: { secretProviderId: providerId, approval } });

      assert.isTrue(yield* logins.needsApproval("thread-a"));
      yield* logins.recordApproval("thread-a");
      assert.isFalse(yield* logins.needsApproval("thread-a"));
      assert.isTrue(yield* logins.needsApproval("thread-b"));

      yield* setApproval("request");
      yield* logins.recordApproval("thread-a");
      assert.isTrue(yield* logins.needsApproval("thread-a"));

      yield* setApproval("application");
      assert.isTrue(yield* logins.needsApproval("thread-a"));
      yield* logins.recordApproval("thread-a");
      assert.isFalse(yield* logins.needsApproval("thread-b"));
    }).pipe(Effect.provide(layer));
  });
});
