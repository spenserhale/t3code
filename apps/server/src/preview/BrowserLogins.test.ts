import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type BrowserLoginApproval,
  type BrowserLoginSettings,
  type BrowserNewLoginSettings,
  SecretProviderId,
  SecretProviderKind,
} from "@t3tools/contracts";
import {
  defineSecretProviderDriver,
  type SecretProviderIdentity,
} from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
    // Fills refuse anything shorter than 4 characters, so every secret given is scrubbed.
    const secrets = ["hunter2", "123456", "abcd", "abcdefgh"];
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

  const redacted = "[filled by password manager]";
  it.each([
    ["overlap", ["abcdef", "defgh"], "x abcdefgh y", `x ${redacted} y`],
    ["containment", ["abcdefgh", "cdef"], "abcdefgh cdef", `${redacted} ${redacted}`],
    ["adjacency", ["abcd", "efgh"], "abcdefgh!", `${redacted}!`],
    ["self-overlap", ["aaaa"], "baaaaaab", `b${redacted}b`],
  ])("leaves no part of a secret showing on %s", (_case, secrets, text, expected) => {
    assert.strictEqual(scrubSecrets(text, secrets), expected);
  });

  // The ways pages, consoles and snapshots write a secret holding quotes, a backslash, a
  // doubled space or a control character.
  const escaped = [String.raw`pa"ss\w0rd  x`, "it's: ok!", "tab\u0001code"];
  it.each([
    ["console JSON", String.raw`{"password":"pa\"ss\\w0rd  x"}`, `{"password":"${redacted}"}`],
    [
      "a snapshot name, whitespace collapsed",
      String.raw`- button "pa\"ss\\w0rd x" [ref=e3]`,
      `- button "${redacted}" [ref=e3]`,
    ],
    [
      "a quoted snapshot key",
      `- 'button "it''s: ok!" [ref=e1]'`,
      `- 'button "${redacted}" [ref=e1]'`,
    ],
    ["a snapshot text value", String.raw`- text: "tab\x01code"`, `- text: "${redacted}"`],
    [
      "a form sent in the address",
      "/login?password=pa%22ss%5Cw0rd++x&next=1",
      `/login?password=${redacted}&next=1`,
    ],
  ])("scrubs a secret written as %s", (_case, text, expected) => {
    assert.strictEqual(scrubSecrets(text, escaped), expected);
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
const github = { id: "h1", title: "GitHub", vaultId: "v9", urls: ["https://github.com"] };
const bothProviders = { secretProviderIds: [work, personal], approval: "thread" } as const;
const me: SecretProviderIdentity = { id: "i1", title: "Me", vault: "Work" };
const partner: SecretProviderIdentity = { id: "i2", title: "Partner", vaultId: "v9" };

/**
 * Logins and identities by the account in a provider's config; an account left out cannot list.
 */
const makeService = (
  listed: Partial<Record<string, ReadonlyArray<typeof grafana | typeof github>>>,
  browserLogins: BrowserLoginSettings = { secretProviderIds: [work], approval: "thread" },
  identities: Partial<Record<string, ReadonlyArray<SecretProviderIdentity>>> = {},
  /** Holds every listing until it opens. */
  gate?: Deferred.Deferred<void>,
) => {
  const calls = {
    list: 0,
    read: [] as Array<string>,
    identityList: 0,
    listing: Deferred.makeUnsafe<void>(),
  };
  // Logins `create` saved, listed with their account's others from then on.
  const created: Array<{
    readonly account: string;
    readonly login: typeof github & { readonly vault: string };
    readonly notes: string;
  }> = [];
  const renewed: Array<string> = [];
  /** How the fake password manager answers for the logins it saved. */
  const newLogins = {
    /** Whether a save or a new password shows the password, as `op` may. */
    printsPassword: true,
    /** Reads of a saved login's password that fail before one succeeds. */
    failedReads: 0,
    /** Holds every read of a saved login's password until it opens. */
    readGate: undefined as Deferred.Deferred<void> | undefined,
    reading: Deferred.makeUnsafe<void>(),
  };
  const driver = defineSecretProviderDriver({
    kind,
    definition: defineSecretProvider({
      kind,
      label: "Fake Vault",
      configSchema: Schema.Struct({
        account: Schema.String,
        serviceAccountToken: Schema.optional(Schema.String),
      }),
      isReference: () => true,
      referencePlaceholder: "",
      invalidReferenceMessage: "",
      supportsLogins: true,
    }),
    read: (_config, references) => Effect.succeed(references.map(() => undefined)),
    logins: {
      list: ({ account }) =>
        Effect.gen(function* () {
          // What the account holds when the listing starts, as with a real provider.
          const own = listed[account];
          const saved = created.flatMap((entry) =>
            entry.account === account ? [entry.login] : [],
          );
          calls.list++;
          Deferred.doneUnsafe(calls.listing, Effect.void);
          if (gate !== undefined) yield* Deferred.await(gate);
          return own && [...own, ...saved];
        }),
      read: ({ account }, login, fields) =>
        Effect.gen(function* () {
          calls.read.push(`${account}:${login.id}@${login.vaultId ?? ""}`);
          if (!created.some((entry) => entry.login.id === login.id)) {
            return Object.fromEntries(fields.map((field) => [field, `${field}-${account}`]));
          }
          Deferred.doneUnsafe(newLogins.reading, Effect.void);
          if (newLogins.readGate !== undefined) yield* Deferred.await(newLogins.readGate);
          if (newLogins.failedReads > 0) {
            newLogins.failedReads--;
            return undefined;
          }
          const renewals = renewed.filter((entry) => entry.includes(`:${login.id}@`)).length;
          return { password: renewals === 0 ? `generated-${login.id}` : `renewed-${login.id}` };
        }),
      create: ({ account }, { title, vault, url, notes }) =>
        Effect.sync(() => {
          const login = {
            id: `n${created.length + 1}`,
            title,
            vault,
            vaultId: "v-new",
            urls: [url],
          };
          created.push({ account, login, notes });
          return {
            login,
            password: newLogins.printsPassword ? `generated-${login.id}` : undefined,
          };
        }),
      regeneratePassword: ({ account }, login, recipe) =>
        Effect.sync(() => {
          renewed.push(`${account}:${login.id}@${login.vaultId ?? ""}:${recipe.length}`);
          return { password: newLogins.printsPassword ? `renewed-${login.id}` : undefined };
        }),
    },
    identities: {
      list: ({ account }) =>
        Effect.sync(() => {
          calls.identityList++;
          return identities[account];
        }),
      read: ({ account }, identity) =>
        Effect.sync(() => {
          calls.read.push(`${account}:${identity.id}@${identity.vaultId ?? ""}`);
          return { firstName: `first-${account}` };
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
  return { layer, calls, created, renewed, newLogins };
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
      // The driver gets its own login back, vault id included.
      assert.deepStrictEqual(calls.read, ["personal:h1@v9"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("shares one listing among the requests that arrive while it runs", () => {
    const gate = Deferred.makeUnsafe<void>();
    const { layer, calls } = makeService({ work: [github] }, undefined, {}, gate);
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      // Each request runs until it waits, so all five arrive before any listing ends.
      const requests = yield* Effect.forEach(Array.from({ length: 5 }), () =>
        logins.candidates("https://github.com/").pipe(Effect.forkChild({ startImmediately: true })),
      );
      yield* Deferred.await(calls.listing);
      yield* Deferred.succeed(gate, undefined);
      const found = yield* Fiber.joinAll(requests);
      assert.deepStrictEqual(
        found.map((each) => each.logins.length),
        [1, 1, 1, 1, 1],
      );
      assert.strictEqual(calls.list, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never refills the cache from a listing begun before it was invalidated", () => {
    const gate = Deferred.makeUnsafe<void>();
    const listed: Partial<Record<string, ReadonlyArray<typeof grafana | typeof github>>> = {
      work: [github],
    };
    const { layer, calls } = makeService(listed, undefined, {}, gate);
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const early = yield* logins
        .candidates("https://grafana.example.com/")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(calls.listing);
      // A login is saved while that listing runs.
      listed.work = [github, grafana];
      yield* logins.invalidate;
      yield* Deferred.succeed(gate, undefined);
      assert.deepStrictEqual((yield* Fiber.join(early)).logins, []);
      const after = yield* logins.candidates("https://grafana.example.com/");
      assert.deepStrictEqual(
        after.logins.map((login) => login.id),
        ["work/g1"],
      );
      yield* logins.candidates("https://grafana.example.com/");
      assert.strictEqual(calls.list, 2);
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
      assert.strictEqual(yield* logins.needsApproval(at, "thread-a", "login"), "thread");
      yield* logins.recordApproval(at, "thread-a", "login");
      assert.isFalse(yield* logins.needsApproval(at, "thread-a", "login"));
      assert.strictEqual(yield* logins.needsApproval(at, "thread-b", "login"), "thread");

      yield* setApproval("request");
      at = yield* revision();
      yield* logins.recordApproval(at, "thread-a", "login");
      assert.strictEqual(yield* logins.needsApproval(at, "thread-a", "login"), "request");

      // Back to once per thread: the earlier approval is forgotten.
      yield* setApproval("thread");
      at = yield* revision();
      assert.strictEqual(yield* logins.needsApproval(at, "thread-a", "login"), "thread");

      yield* setApproval("application");
      at = yield* revision();
      assert.strictEqual(yield* logins.needsApproval(at, "thread-a", "login"), "application");
      yield* logins.recordApproval(at, "thread-a", "login");
      assert.isFalse(yield* logins.needsApproval(at, "thread-b", "login"));

      yield* setApproval("never");
      at = yield* revision();
      assert.isFalse(yield* logins.needsApproval(at, "thread-c", "login"));
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
      yield* logins.recordApproval(revision, "thread-a", "login");
      yield* choose([]);
      yield* logins.candidates("https://github.com/").pipe(Effect.flip);
      yield* choose([work]);
      const again = yield* logins.candidates("https://github.com/");
      assert.notStrictEqual(again.revision, revision);
      assert.strictEqual(
        yield* logins.needsApproval(again.revision, "thread-a", "login"),
        "thread",
      );

      yield* logins.recordApproval(again.revision, "thread-a", "login");
      yield* choose([work, personal]);
      yield* logins.check(again.revision).pipe(Effect.flip);
      const widened = yield* logins.candidates("https://github.com/");
      assert.strictEqual(
        yield* logins.needsApproval(widened.revision, "thread-a", "login"),
        "thread",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists again and forgets approvals when only the service account token changes", () => {
    const { layer, calls } = makeService({ work: [github] });
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const useToken = (serviceAccountToken: string) =>
        settings.updateSettings({
          secretProviders: {
            [work]: { kind, label: "Work", config: { account: "work", serviceAccountToken } },
          },
        });
      yield* useToken("ops_first");
      const first = yield* logins.candidates("https://github.com/");
      yield* logins.recordApproval(first.revision, "thread-a", "login");

      yield* useToken("ops_second");
      yield* logins.check(first.revision).pipe(Effect.flip);
      const second = yield* logins.candidates("https://github.com/");
      assert.strictEqual(
        yield* logins.needsApproval(second.revision, "thread-a", "login"),
        "thread",
      );
      assert.strictEqual(calls.list, 2);
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
      yield* logins.recordApproval(revision, "thread-a", "login").pipe(Effect.flip);
      yield* logins.check(revision).pipe(Effect.flip);
      const now = yield* logins.candidates("https://github.com/");
      assert.strictEqual(yield* logins.needsApproval(now.revision, "thread-a", "login"), "thread");
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
      yield* logins.recordApproval(revision, "thread-a", "login").pipe(Effect.flip);
      yield* logins.read(revision, found[0]!, ["password"]).pipe(Effect.flip);
      yield* logins.check(revision).pipe(Effect.flip);
      const now = yield* logins.candidates("https://github.com/");
      assert.strictEqual(yield* logins.needsApproval(now.revision, "thread-b", "login"), to);
    }).pipe(Effect.provide(layer));
  });
});

describe("BrowserLogins identities", () => {
  it.effect("offers identities from every chosen provider, listing each once", () => {
    const { layer, calls } = makeService({ work: [grafana] }, bothProviders, {
      work: [me],
      personal: [partner],
    });
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const found = yield* logins.identityCandidates("identity");
      assert.deepStrictEqual(found.identities, [
        { ...me, id: "work/i1", account: "Work" },
        { ...partner, id: "personal/i2", account: "Personal" },
      ]);
      yield* logins.identityCandidates("identityRead");
      // Identities have their own list, so listing logins did not list them, nor the reverse.
      yield* logins.candidates("https://grafana.example.com/");
      assert.deepStrictEqual(
        { list: calls.list, read: calls.read, identityList: calls.identityList },
        { list: 2, read: [], identityList: 2 },
      );

      const values = yield* logins.readIdentity(found.revision, found.identities[1]!);
      assert.deepStrictEqual(values, { firstName: "first-personal" });
      assert.deepStrictEqual(calls.read, ["personal:i2@v9"]);
      for (const id of ["stranger/i1", "i1"]) {
        const error = yield* logins
          .readIdentity(found.revision, { ...found.identities[0]!, id })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "not_configured");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("a provider that cannot list identities hides only its own", () => {
    const { layer } = makeService({}, bothProviders, { personal: [partner] });
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const found = yield* logins.identityCandidates("identity");
      assert.deepStrictEqual(
        found.identities.map((identity) => identity.id),
        ["personal/i2"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("approves logins, identity fills and identity reads each on their own", () => {
    const { layer } = makeService({ work: [github] }, undefined, { work: [me] });
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const { revision } = yield* logins.identityCandidates("identity");
      yield* logins.recordApproval(revision, "thread-a", "login");
      assert.strictEqual(yield* logins.needsApproval(revision, "thread-a", "identity"), "thread");
      yield* logins.recordApproval(revision, "thread-a", "identity");
      assert.isFalse(yield* logins.needsApproval(revision, "thread-a", "identity"));
      // Reading has its own setting, which asks every time unless the user chose otherwise.
      yield* logins.recordApproval(revision, "thread-a", "identityRead");
      assert.strictEqual(
        yield* logins.needsApproval(revision, "thread-a", "identityRead"),
        "request",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("showing identities to the agent can be turned off, apart from filling them", () => {
    const { layer, calls } = makeService(
      { work: [github] },
      { secretProviderIds: [work], approval: "never", identityReadApproval: "off" },
      { work: [me] },
    );
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const off = yield* logins.identityCandidates("identityRead").pipe(Effect.flip);
      assert.strictEqual(off.reason, "not_configured");
      assert.include(off.message, "preview_fill_identity");
      // Nothing was listed for a read that cannot happen.
      assert.strictEqual(calls.identityList, 0);
      const { revision } = yield* logins.identityCandidates("identity");
      assert.isFalse(yield* logins.needsApproval(revision, "thread-a", "identity"));
      const refused = yield* logins
        .needsApproval(revision, "thread-a", "identityRead")
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "not_configured");
    }).pipe(Effect.provide(layer));
  });

  it.effect("changing the identity read setting forgets approvals of every kind", () => {
    const { layer } = makeService({ work: [github] }, undefined, { work: [me] });
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const setRead = (identityReadApproval: "thread" | "request") =>
        settings.updateSettings({
          browserLogins: { secretProviderIds: [work], approval: "thread", identityReadApproval },
        });
      yield* setRead("thread");
      const first = yield* logins.identityCandidates("identityRead");
      yield* logins.recordApproval(first.revision, "thread-a", "login");
      yield* logins.recordApproval(first.revision, "thread-a", "identityRead");

      yield* setRead("request");
      yield* logins.check(first.revision).pipe(Effect.flip);
      yield* logins.readIdentity(first.revision, first.identities[0]!).pipe(Effect.flip);
      yield* setRead("thread");
      const now = yield* logins.identityCandidates("identityRead");
      assert.notStrictEqual(now.revision, first.revision);
      assert.strictEqual(yield* logins.needsApproval(now.revision, "thread-a", "login"), "thread");
      assert.strictEqual(
        yield* logins.needsApproval(now.revision, "thread-a", "identityRead"),
        "thread",
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("BrowserLogins new logins", () => {
  const signUps: BrowserNewLoginSettings = { secretProviderId: work, vault: "Sign-ups" };
  const savingTo = (
    newLogins: BrowserNewLoginSettings,
    approval: BrowserLoginApproval = "thread",
  ) => ({ secretProviderIds: [work], approval, newLogins }) as const;
  const shop = {
    threadId: "thread-a",
    threadTitle: "Sign up\nfor hosting",
    title: "shop.test",
    url: "https://shop.test",
    username: "ada@example.com",
    recipe: { length: 24, digits: true, symbols: true },
  };
  /** A call for `shop` that names no earlier login. */
  const fresh = {
    threadId: shop.threadId,
    loginId: undefined,
    url: shop.url,
    username: shop.username,
  };

  it.effect("saves a login where the user chose, lists it at once, and asks about it apart", () => {
    const { layer, calls, created } = makeService({ work: [grafana] }, savingTo(signUps));
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      assert.deepStrictEqual((yield* logins.candidates("https://shop.test/signup")).logins, []);
      const { revision, ...destination } = yield* logins.newLoginDestination(fresh);
      assert.deepStrictEqual(destination, { account: "Work", vault: "Sign-ups" });

      // Approving a login fill on this thread does not approve creating one.
      yield* logins.recordApproval(revision, "thread-a", "login");
      assert.strictEqual(yield* logins.needsApproval(revision, "thread-a", "newLogin"), "thread");
      yield* logins.recordApproval(revision, "thread-a", "newLogin");
      assert.isFalse(yield* logins.needsApproval(revision, "thread-a", "newLogin"));

      const login = {
        id: "work/n1",
        title: "shop.test",
        vault: "Sign-ups",
        vaultId: "v-new",
        urls: ["https://shop.test"],
        account: "Work",
      };
      assert.deepStrictEqual(yield* logins.createLogin(revision, shop), {
        login,
        password: "generated-n1",
      });
      assert.deepStrictEqual(
        created.map((entry) => entry.notes),
        [
          'Created by T3 Code for the thread "Sign up for hosting" on 1970-01-01 for https://shop.test. It can be deleted if the sign-up did not finish.',
        ],
      );
      // The list cached before the login existed is dropped, so preview_fill_login offers it now.
      assert.deepStrictEqual((yield* logins.candidates("https://shop.test/login")).logins, [login]);
      assert.strictEqual(calls.list, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives a new password only to a login this thread created", () => {
    const { layer, renewed } = makeService({ work: [grafana] }, savingTo(signUps, "never"));
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const { revision } = yield* logins.newLoginDestination(fresh);
      const { login } = yield* logins.createLogin(revision, shop);
      yield* logins.newLoginFilled("thread-a", login.id);
      const shorter = { length: 12, digits: true, symbols: false };
      assert.deepStrictEqual(yield* logins.newLoginDestination({ ...fresh, loginId: login.id }), {
        revision,
        account: "Work",
        vault: "Sign-ups",
        login,
        filled: true,
      });
      assert.deepStrictEqual(
        yield* logins.regeneratePassword(revision, "thread-a", login.id, shorter),
        { login, password: "renewed-n1" },
      );
      // The driver gets its own id back, in the vault the login was saved in.
      assert.deepStrictEqual(renewed, ["work:n1@v-new:12"]);

      // Another thread's login, or one the user saved, may be in use on its site.
      for (const [threadId, loginId] of [
        ["thread-b", login.id],
        ["thread-a", "work/g1"],
      ] as const) {
        const refused = yield* logins
          .regeneratePassword(revision, threadId, loginId, shorter)
          .pipe(Effect.flip);
        assert.include(refused.message, "Omit `login` to create a new one.");
        yield* logins.newLoginDestination({ ...fresh, threadId, loginId }).pipe(Effect.flip);
      }
      assert.deepStrictEqual(renewed, ["work:n1@v-new:12"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a login whose password could not be read back, and gives it to a retry", () => {
    const { layer, created, renewed, newLogins } = makeService(
      { work: [grafana] },
      savingTo(signUps, "never"),
    );
    newLogins.printsPassword = false;
    newLogins.failedReads = 1;
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const { revision } = yield* logins.newLoginDestination(fresh);
      const failed = yield* logins.createLogin(revision, shop).pipe(Effect.flip);
      assert.include(failed.message, 'Call again with login "work/n1"');
      // The same thread, site and username continue the saved login while it was never filled.
      const retry = yield* logins.newLoginDestination(fresh);
      assert.deepStrictEqual([retry.login?.id, retry.filled], ["work/n1", false]);
      assert.deepStrictEqual(yield* logins.readNewLogin(revision, "thread-a", "work/n1"), {
        login: retry.login,
        password: "generated-n1",
      });
      const named = yield* logins.newLoginDestination({ ...fresh, loginId: "work/n1" });
      assert.deepStrictEqual([named.login?.id, named.filled], ["work/n1", false]);
      for (const other of [
        { ...fresh, username: "bob@example.com" },
        { ...fresh, url: "https://other.test" },
        { ...fresh, threadId: "thread-b" },
      ]) {
        assert.isUndefined((yield* logins.newLoginDestination(other)).login);
      }
      // Once filled, the site may hold the password: only naming the login renews it.
      yield* logins.newLoginFilled("thread-a", "work/n1");
      assert.isUndefined((yield* logins.newLoginDestination(fresh)).login);
      const renewal = yield* logins.newLoginDestination({ ...fresh, loginId: "work/n1" });
      assert.isTrue(renewal.filled);
      // A new password that could not be read back has reached no page, so it is read next.
      newLogins.failedReads = 1;
      const unread = yield* logins
        .regeneratePassword(revision, "thread-a", "work/n1", shop.recipe)
        .pipe(Effect.flip);
      assert.include(unread.message, 'Call again with login "work/n1"');
      assert.isFalse((yield* logins.newLoginDestination(fresh)).filled);
      assert.strictEqual(
        (yield* logins.readNewLogin(revision, "thread-a", "work/n1")).password,
        "renewed-n1",
      );
      assert.strictEqual(created.length, 1);
      assert.strictEqual(renewed.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a caller that gives up after the save still leaves the login to its thread", () => {
    const { layer, created, newLogins } = makeService(
      { work: [grafana] },
      savingTo(signUps, "never"),
    );
    newLogins.printsPassword = false;
    newLogins.readGate = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const { revision } = yield* logins.newLoginDestination(fresh);
      const call = yield* logins
        .createLogin(revision, shop)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(newLogins.reading);
      yield* Fiber.interrupt(call);
      assert.strictEqual((yield* logins.newLoginDestination(fresh)).login?.id, "work/n1");
      yield* Deferred.succeed(newLogins.readGate!, undefined);
      assert.strictEqual(
        (yield* logins.readNewLogin(revision, "thread-a", "work/n1")).password,
        "generated-n1",
      );
      assert.strictEqual(created.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("is off until the user chooses where, among the chosen password managers", () => {
    const { layer, created } = makeService({ work: [grafana] });
    return Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const logins = yield* BrowserLogins.BrowserLogins;
      const choose = (newLogins: BrowserNewLoginSettings) =>
        settings.updateSettings({ browserLogins: savingTo(newLogins) });

      const off = yield* logins.newLoginDestination(fresh).pipe(Effect.flip);
      assert.include(
        off.message,
        "choose where new logins are saved in Settings > Browser > Logins",
      );
      const { revision } = yield* logins.candidates("https://shop.test/");
      yield* logins.createLogin(revision, shop).pipe(Effect.flip);

      yield* choose({ secretProviderId: personal, vault: "Sign-ups" });
      const unchosen = yield* logins.newLoginDestination(fresh).pipe(Effect.flip);
      assert.include(unchosen.message, "is not one chosen for browser logins");

      yield* choose(signUps);
      const first = yield* logins.newLoginDestination(fresh);
      // Moving new logins to another vault starts a new generation, like any change here.
      yield* choose({ ...signUps, vault: "Other" });
      yield* logins.createLogin(first.revision, shop).pipe(Effect.flip);
      const second = yield* logins.newLoginDestination(fresh);
      assert.strictEqual(second.vault, "Other");
      yield* logins.createLogin(second.revision, shop);
      assert.strictEqual(created.length, 1);
    }).pipe(Effect.provide(layer));
  });
});
