import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type BrowserLoginApproval,
  type BrowserLoginSettings,
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
const work = SecretProviderId.make("work");
const personal = SecretProviderId.make("personal");
const grafana = {
  id: "g1",
  title: "Grafana",
  vault: "Work",
  urls: ["https://grafana.example.com"],
};
const github = { id: "h1", title: "GitHub", urls: ["https://github.com"] };
const bothProviders = { secretProviderIds: [work, personal], approval: "thread" } as const;

/** Logins by the account in a provider's config; an account left out cannot list. */
const makeService = (
  listed: Partial<Record<string, ReadonlyArray<typeof grafana | typeof github>>>,
  browserLogins: BrowserLoginSettings = { secretProviderIds: [work], approval: "thread" },
) => {
  const calls = { list: 0, read: [] as Array<string> };
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
      list: ({ account }) =>
        Effect.sync(() => {
          calls.list++;
          return listed[account];
        }),
      read: ({ account }, login, fields) =>
        Effect.sync(() => {
          calls.read.push(`${account}:${login.id}`);
          return Object.fromEntries(fields.map((field) => [field, `${field}-${account}`]));
        }),
    },
  });
  const layer = Layer.effect(BrowserLogins.BrowserLogins, BrowserLogins.make([driver])).pipe(
    Layer.provideMerge(
      Settings.layerTest({
        secretProviders: {
          [work]: { kind, label: "Work", config: { account: "work" } },
          [personal]: { kind, label: "Personal", config: { account: "personal" } },
        },
        browserLogins,
      }),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { layer, calls };
};

describe("BrowserLogins", () => {
  it.effect("offers the page's logins from every chosen provider, listing each once", () => {
    const { layer, calls } = makeService({ work: [grafana], personal: [github] }, bothProviders);
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const first = yield* logins.candidates("https://grafana.example.com/login");
      assert.deepStrictEqual(first.logins, [{ ...grafana, id: "work/g1", account: "Work" }]);
      const second = yield* logins.candidates("https://github.com/login");
      assert.deepStrictEqual(second.logins, [
        { ...github, id: "personal/h1", account: "Personal" },
      ]);
      assert.strictEqual(calls.list, 2);

      const values = yield* logins.read(second.revision, second.logins[0]!, ["password"]);
      assert.deepStrictEqual(values, { password: "password-personal" });
      assert.deepStrictEqual(calls.read, ["personal:h1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads only from a chosen provider", () => {
    const { layer, calls } = makeService({ work: [grafana], personal: [github] }, bothProviders);
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const [personalLogin] = (yield* logins.candidates("https://github.com/")).logins;
      yield* settings.updateSettings({
        browserLogins: { secretProviderIds: [work], approval: "thread" },
      });
      const { revision } = yield* logins.candidates("https://github.com/");
      for (const id of ["personal/h1", "stranger/h1", "h1"]) {
        const error = yield* logins
          .read(revision, { ...personalLogin!, id }, ["password"])
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "not_configured");
      }
      assert.deepStrictEqual(calls.read, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still uses the single provider saved before several could be chosen", () => {
    const { layer } = makeService(
      { work: [grafana] },
      { secretProviderId: work, approval: "thread" },
    );
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const found = yield* logins.candidates("https://grafana.example.com/");
      assert.deepStrictEqual(found.logins, [{ ...grafana, id: "work/g1", account: "Work" }]);
      const values = yield* logins.read(found.revision, found.logins[0]!, ["username"]);
      assert.deepStrictEqual(values, { username: "username-work" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a provider that cannot list hides only its own logins", () => {
    const { layer } = makeService({ work: [grafana] }, bothProviders);
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const found = yield* logins.candidates("https://grafana.example.com/");
      assert.deepStrictEqual(found.logins, [{ ...grafana, id: "work/g1", account: "Work" }]);
      assert.deepStrictEqual((yield* logins.candidates("https://github.com/")).logins, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails clearly when no provider can list", () => {
    const { layer } = makeService({}, bothProviders);
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const error = yield* logins.candidates("https://github.com/").pipe(Effect.flip);
      assert.strictEqual(error.reason, "unreadable");
    }).pipe(Effect.provide(layer));
  });

  it.effect("is off until a provider is chosen", () => {
    const { layer } = makeService({ work: [github] });
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      for (const browserLogins of [
        { approval: "thread" },
        // An empty list wins over the older single provider.
        { secretProviderId: work, secretProviderIds: [], approval: "thread" },
      ] as const) {
        yield* settings.updateSettings({ browserLogins });
        const error = yield* logins.candidates("https://github.com/").pipe(Effect.flip);
        assert.strictEqual(error.reason, "not_configured");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks every time, once per thread, once for all threads, or never", () => {
    const { layer } = makeService({ work: [github] });
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const setApproval = (approval: BrowserLoginApproval) =>
        settings.updateSettings({ browserLogins: { secretProviderIds: [work], approval } });
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

  it.effect("forgets approvals when the chosen providers change", () => {
    const { layer } = makeService({ work: [github], personal: [] });
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const choose = (secretProviderIds: ReadonlyArray<SecretProviderId>) =>
        settings.updateSettings({ browserLogins: { secretProviderIds, approval: "thread" } });
      const { revision } = yield* logins.candidates("https://github.com/");
      yield* logins.recordApproval(revision, "thread-a");
      yield* choose([]);
      yield* logins.candidates("https://github.com/").pipe(Effect.flip);
      yield* choose([work]);
      const again = yield* logins.candidates("https://github.com/");
      assert.notStrictEqual(again.revision, revision);
      assert.strictEqual(yield* logins.needsApproval(again.revision, "thread-a"), "thread");

      yield* logins.recordApproval(again.revision, "thread-a");
      yield* choose([work, personal]);
      yield* logins.check(again.revision).pipe(Effect.flip);
      const widened = yield* logins.candidates("https://github.com/");
      assert.strictEqual(yield* logins.needsApproval(widened.revision, "thread-a"), "thread");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an answer begun before the setting changed, even if it changed back", () => {
    const { layer } = makeService({ work: [github] });
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const setApproval = (approval: BrowserLoginApproval) =>
        settings.updateSettings({ browserLogins: { secretProviderIds: [work], approval } });
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
    const { layer } = makeService({ work: [github] });
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const setApproval = (approval: BrowserLoginApproval) =>
        settings.updateSettings({ browserLogins: { secretProviderIds: [work], approval } });
      yield* setApproval(from);
      const { revision, logins: found } = yield* logins.candidates("https://github.com/");
      yield* setApproval(to);
      yield* logins.recordApproval(revision, "thread-a").pipe(Effect.flip);
      yield* logins.read(revision, found[0]!, ["password"]).pipe(Effect.flip);
      yield* logins.check(revision).pipe(Effect.flip);
      const now = yield* logins.candidates("https://github.com/");
      assert.strictEqual(yield* logins.needsApproval(now.revision, "thread-b"), to);
    }).pipe(Effect.provide(layer));
  });
});
