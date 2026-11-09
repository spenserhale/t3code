import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type BrowserLoginApproval,
  SecretProviderId,
  SecretProviderKind,
} from "@t3tools/contracts";
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
  it("replaces filled secrets in keys and values, longest first", () => {
    const secrets = ["hunter2", "123456", "abcd", "abcdefgh", "ok"];
    const redacted = "[filled by password manager]";
    assert.deepStrictEqual<unknown>(
      scrubSecrets(
        {
          visibleText: "code 123456, ok",
          consoleEntries: [{ text: "pw=hunter2" }],
          forged: { mimeType: "image/png", data: "hunter2" },
          result: { hunter2: true, overlap: "abcdefgh" },
          count: 3,
        },
        secrets,
      ),
      {
        visibleText: `code ${redacted}, ok`,
        consoleEntries: [{ text: `pw=${redacted}` }],
        forged: { mimeType: "image/png", data: redacted },
        result: { [redacted]: true, overlap: redacted },
        count: 3,
      },
    );
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
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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

  it.effect("asks every time, once per thread, once for all threads, or never", () => {
    const { layer } = makeService([github]);
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const setApproval = (approval: BrowserLoginApproval) =>
        settings.updateSettings({ browserLogins: { secretProviderId: providerId, approval } });
      const revision = () =>
        logins.candidates("https://github.com/").pipe(Effect.map((found) => found.revision));

      let at = yield* revision();
      assert.strictEqual(yield* logins.needsApproval(at, "thread-a"), "thread");
      yield* logins.recordApproval(at, "thread-a");
      assert.isFalse(yield* logins.needsApproval(at, "thread-a"));
      assert.strictEqual(yield* logins.needsApproval(at, "thread-b"), "thread");

      yield* setApproval("request");
      at = yield* revision();
      yield* logins.recordApproval(at, "thread-a");
      assert.strictEqual(yield* logins.needsApproval(at, "thread-a"), "request");

      // Back to once per thread: the earlier approval is forgotten.
      yield* setApproval("thread");
      at = yield* revision();
      assert.strictEqual(yield* logins.needsApproval(at, "thread-a"), "thread");

      yield* setApproval("application");
      at = yield* revision();
      assert.strictEqual(yield* logins.needsApproval(at, "thread-a"), "application");
      yield* logins.recordApproval(at, "thread-a");
      assert.isFalse(yield* logins.needsApproval(at, "thread-b"));

      yield* setApproval("never");
      at = yield* revision();
      assert.isFalse(yield* logins.needsApproval(at, "thread-c"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("forgets approvals when logins are turned off and on", () => {
    const { layer } = makeService([github]);
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const { revision } = yield* logins.candidates("https://github.com/");
      yield* logins.recordApproval(revision, "thread-a");
      yield* settings.updateSettings({ browserLogins: { approval: "thread" } });
      yield* logins.candidates("https://github.com/").pipe(Effect.flip);
      yield* settings.updateSettings({
        browserLogins: { secretProviderId: providerId, approval: "thread" },
      });
      const again = yield* logins.candidates("https://github.com/");
      assert.notStrictEqual(again.revision, revision);
      assert.strictEqual(yield* logins.needsApproval(again.revision, "thread-a"), "thread");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an answer begun before the setting changed, even if it changed back", () => {
    const { layer } = makeService([github]);
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const setApproval = (approval: "request" | "thread") =>
        settings.updateSettings({ browserLogins: { secretProviderId: providerId, approval } });
      const { revision } = yield* logins.candidates("https://github.com/");
      yield* setApproval("request");
      yield* logins.candidates("https://github.com/");
      yield* setApproval("thread");
      yield* logins.recordApproval(revision, "thread-a").pipe(Effect.flip);
      yield* logins.check(revision).pipe(Effect.flip);
      const now = yield* logins.candidates("https://github.com/");
      assert.strictEqual(yield* logins.needsApproval(now.revision, "thread-a"), "thread");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    // The user widens the setting while the "every login" prompt is open.
    ["request", "application"],
    // The user turns asking back on while a fill that was not asked about is under way.
    ["never", "thread"],
  ] as const)("rejects steps begun under %s once the setting changed to %s", ([from, to]) => {
    const { layer } = makeService([github]);
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const setApproval = (approval: BrowserLoginApproval) =>
        settings.updateSettings({ browserLogins: { secretProviderId: providerId, approval } });
      yield* setApproval(from);
      const { revision } = yield* logins.candidates("https://github.com/");
      yield* setApproval(to);
      yield* logins.recordApproval(revision, "thread-a").pipe(Effect.flip);
      yield* logins.read(revision, github, ["password"]).pipe(Effect.flip);
      yield* logins.check(revision).pipe(Effect.flip);
      const now = yield* logins.candidates("https://github.com/");
      assert.strictEqual(yield* logins.needsApproval(now.revision, "thread-b"), to);
    }).pipe(Effect.provide(layer));
  });
});
