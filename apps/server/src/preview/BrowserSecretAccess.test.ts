import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as BrowserLogins from "./BrowserLogins.ts";
import * as BrowserSecretAccess from "./BrowserSecretAccess.ts";

const scope = {
  item: "work/first",
  threadId: "thread-1",
  tabId: "tab-1",
  origin: "https://good.test",
  sourceUrl: "https://good.test/login",
  revision: "revision-1",
};
const request: BrowserSecretAccess.SecretRequest = {
  ...scope,
  kind: "login",
  deadline: 60 * 60 * 1000,
};
const first = { id: scope.item, title: "First" };
const setup = (
  options: { revision?: string; missing?: boolean; unreadable?: boolean; denied?: boolean } = {},
) => {
  const approved: Array<string> = [];
  const reads: Array<string> = [];
  const services: BrowserSecretAccess.SecretAccessServices = {
    logins: {
      escalation: Effect.succeed({
        revision: options.revision ?? scope.revision,
        escalation: "device",
        providers: [{ id: "work", account: "Work", unattended: false }],
      }),
      needsApproval: () => Effect.succeed(true),
      recordApproval: () => Effect.void,
      check: () => Effect.void,
    },
    desktopChannel: {
      available: true,
      chooseLogin: () => Effect.undefined,
      approveLogin: (_key, _timeout, prompt) =>
        Effect.sync(() => {
          approved.push(prompt.kind ?? "login");
          return options.denied === true ? false : "once";
        }),
    },
    relay: undefined,
  };
  const catalog: BrowserSecretAccess.SecretCatalog<typeof first, { totp: string }> = {
    what: "a login",
    find: () => Effect.succeed(options.missing ? [] : [first]),
    read: () =>
      Effect.suspend(() => {
        reads.push(first.id);
        return options.unreadable
          ? Effect.fail(
              new BrowserLogins.BrowserLoginError({ reason: "unreadable", message: "Locked" }),
            )
          : Effect.succeed({ totp: `fresh-code-${reads.length}` });
      }),
  };
  return {
    approved,
    reads,
    resolve: (input = request) => BrowserSecretAccess.resolve(services, input, catalog),
  };
};

describe("BrowserSecretAccess login continuation", () => {
  it.effect("reads fresh values for each continuation under one successful-fill receipt", () => {
    const test = setup();
    return Effect.gen(function* () {
      yield* test.resolve({ ...request, item: undefined });
      const receipt = yield* BrowserSecretAccess.recordLoginFill(scope);
      const next = yield* test.resolve({ ...request, loginApproval: receipt });
      const retry = yield* test.resolve({ ...request, loginApproval: receipt });
      assert.deepStrictEqual(test.approved, ["login"]);
      assert.deepStrictEqual(test.reads, [scope.item, scope.item, scope.item]);
      assert.strictEqual(next.status === "found" && next.values.totp, "fresh-code-2");
      assert.strictEqual(retry.status === "found" && retry.values.totp, "fresh-code-3");
    });
  });

  it.effect("expires five minutes from the first fill without extending on continuation", () => {
    const test = setup();
    return Effect.gen(function* () {
      const receipt = yield* BrowserSecretAccess.recordLoginFill(scope);
      yield* TestClock.adjust("4 minutes");
      yield* test.resolve({ ...request, loginApproval: receipt });
      assert.strictEqual(yield* BrowserSecretAccess.recordLoginFill(scope, receipt), receipt);
      yield* TestClock.adjust("1 minute");
      yield* test.resolve({ ...request, loginApproval: receipt });
      assert.deepStrictEqual(test.approved, ["login"]);
    });
  });

  const changed: ReadonlyArray<Partial<BrowserSecretAccess.SecretRequest>> = [
    { kind: "identity" },
    { kind: "identityRead" },
    { kind: "newLogin" },
    { kind: "secretReference" },
    { item: undefined },
    { item: "work/second" },
    { threadId: "thread-2" },
    { tabId: "tab-2" },
    { origin: "https://sub.good.test" },
    { sourceUrl: "https://good.test/other" },
    { reference: "op://Work/First" },
  ];
  it.effect.each(changed)("requires approval when receipt binding changes: %j", (change) => {
    const test = setup();
    return Effect.gen(function* () {
      const receipt = yield* BrowserSecretAccess.recordLoginFill(scope);
      yield* test.resolve({ ...request, ...change, loginApproval: receipt }).pipe(Effect.result);
      assert.strictEqual(test.approved.length, 1);
    });
  });

  it.effect("never renews a receipt when its continuation finishes after expiry", () =>
    Effect.gen(function* () {
      const receipt = yield* BrowserSecretAccess.recordLoginFill(scope);
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(yield* BrowserSecretAccess.recordLoginFill(scope, receipt), receipt);
    }),
  );

  it.effect("rejects cloned receipts and receipts from old settings", () => {
    const test = setup();
    const changed = setup({ revision: "revision-2" });
    return Effect.gen(function* () {
      const receipt = yield* BrowserSecretAccess.recordLoginFill(scope);
      yield* test.resolve({ ...request, loginApproval: { ...receipt } });
      yield* changed.resolve({ ...request, loginApproval: receipt });
      assert.deepStrictEqual(test.approved, ["login"]);
      assert.deepStrictEqual(changed.approved, ["login"]);
    });
  });

  it.effect.each(["missing", "unreadable"] as const)(
    "stops when remembered item becomes %s",
    (problem) => {
      const test = setup({ [problem]: true });
      return Effect.gen(function* () {
        const receipt = yield* BrowserSecretAccess.recordLoginFill(scope);
        const result = yield* test
          .resolve({ ...request, loginApproval: receipt })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.deepStrictEqual(test.approved, []);
        assert.strictEqual(test.reads.length, problem === "missing" ? 0 : 1);
      });
    },
  );

  it.effect("denied normal approval stops before values are read", () => {
    const test = setup({ denied: true });
    return Effect.gen(function* () {
      const result = yield* test.resolve().pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(test.reads, []);
    });
  });
});
