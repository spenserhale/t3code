import { assert, describe, it } from "@effect/vitest";
import type { PreviewLoginChoice } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as BrowserLoginChoice from "./BrowserLoginChoice.ts";
import * as BrowserLogins from "./BrowserLogins.ts";

const first = { id: "work/first", title: "First", account: "Work", urls: ["https://good.test"] };
const second = { ...first, id: "work/second", title: "Second" };
const source = { ...second, urls: ["https://www.rocketmoney.com"] };
const request = (candidates = [first, second]) => ({
  revision: "revision-1",
  candidates,
  threadId: "thread-1",
  tabId: "tab-1",
  origin: "https://good.test",
  deadline: 60_000,
});

const setup = (
  options: {
    readonly selected?: string | undefined;
    readonly available?: boolean;
    readonly failedUsername?: string;
    readonly afterChoice?: Effect.Effect<void>;
    readonly settingsChanged?: () => boolean;
  } = {},
) => {
  const reads: Array<{ readonly id: string; readonly fields: ReadonlyArray<string> }> = [];
  const prompts: Array<ReadonlyArray<PreviewLoginChoice>> = [];
  const services = {
    logins: {
      check: () =>
        Effect.suspend(() =>
          options.settingsChanged?.() === true
            ? Effect.fail(
                new BrowserLogins.BrowserLoginError({
                  reason: "changed",
                  message: "Settings changed",
                }),
              )
            : Effect.void,
        ),
      read: (
        _revision: string,
        login: BrowserLogins.BrowserLoginCandidate,
        fields: ReadonlyArray<string>,
      ) =>
        Effect.suspend(() => {
          reads.push({ id: login.id, fields });
          return login.id === options.failedUsername
            ? Effect.fail(
                new BrowserLogins.BrowserLoginError({ reason: "unreadable", message: "Locked" }),
              )
            : Effect.succeed({ username: `user-${login.id}` });
        }),
    },
    desktopChannel: {
      available: options.available ?? true,
      chooseLogin: (
        _key: unknown,
        _timeoutMs: number,
        prompt: { readonly candidates: ReadonlyArray<PreviewLoginChoice> },
      ) =>
        Effect.gen(function* () {
          prompts.push(prompt.candidates);
          if (options.afterChoice) yield* options.afterChoice;
          return options.selected;
        }),
    },
    relay: undefined,
  };
  return { reads, prompts, services };
};

describe("BrowserLoginChoice", () => {
  it.effect("keeps one current-site login automatic without reading a username", () => {
    const test = setup();
    return Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* BrowserLoginChoice.select(test.services, request([first])),
        first,
      );
      assert.deepStrictEqual(test.reads, []);
      assert.deepStrictEqual(test.prompts, []);
    });
  });

  it.effect("reads only usernames and returns exactly the user's second login", () => {
    const test = setup({ selected: second.id, failedUsername: first.id });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* BrowserLoginChoice.select(test.services, request()), {
        ...second,
        userChosen: true,
      });
      assert.deepStrictEqual(test.reads, [
        { id: first.id, fields: ["username"] },
        { id: second.id, fields: ["username"] },
      ]);
      assert.deepStrictEqual(test.prompts, [
        [
          { id: first.id, title: first.title, account: "Work", websites: first.urls },
          {
            id: second.id,
            title: second.title,
            account: "Work",
            username: `user-${second.id}`,
            websites: second.urls,
          },
        ],
      ]);
    });
  });

  it.effect(
    "requires explicit choice for a sole source-site login and binds permission to this origin",
    () => {
      const test = setup({ selected: source.id });
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* BrowserLoginChoice.select(test.services, request([source])), {
          ...source,
          userChosen: true,
          fillOrigin: "https://good.test",
        });
        assert.lengthOf(test.prompts, 1);
      });
    },
  );

  it.effect.each([undefined, "work/unknown"])(
    "refuses cancelled or unknown choice %s",
    (selected) => {
      const test = setup({ selected });
      return Effect.gen(function* () {
        const error = yield* BrowserLoginChoice.select(test.services, request()).pipe(Effect.flip);
        assert.strictEqual(error.reason, "refused");
        assert.isTrue(test.reads.every((read) => read.fields.join() === "username"));
      });
    },
  );

  it.effect("refuses expired choice", () => {
    const test = setup({ selected: second.id, afterChoice: TestClock.adjust(60_000) });
    return Effect.gen(function* () {
      const error = yield* BrowserLoginChoice.select(test.services, request()).pipe(Effect.flip);
      assert.strictEqual(error.reason, "refused");
    });
  });

  it.effect("refuses page or settings changes after choice before returning authorization", () => {
    let changed = false;
    const test = setup({
      selected: second.id,
      afterChoice: Effect.sync(() => {
        changed = true;
      }),
    });
    return Effect.gen(function* () {
      const error = yield* BrowserLoginChoice.select(test.services, {
        ...request(),
        checkPage: Effect.suspend(() =>
          changed
            ? Effect.fail(
                new BrowserLogins.BrowserLoginError({ reason: "refused", message: "Page changed" }),
              )
            : Effect.void,
        ),
      }).pipe(Effect.flip);
      assert.strictEqual(error.message, "Page changed");
    });
  });

  it.effect("requires a connected chooser instead of choosing a service-account login", () => {
    const test = setup({ available: false });
    return Effect.gen(function* () {
      const error = yield* BrowserLoginChoice.select(test.services, request()).pipe(Effect.flip);
      assert.include(error.message, "desktop");
      assert.deepStrictEqual(test.prompts, []);
    });
  });

  it.effect("invalidates choice when settings change while the picker is open", () => {
    let changed = false;
    const test = setup({
      selected: second.id,
      settingsChanged: () => changed,
      afterChoice: Effect.sync(() => {
        changed = true;
      }),
    });
    return Effect.gen(function* () {
      const error = yield* BrowserLoginChoice.select(test.services, request()).pipe(Effect.flip);
      assert.strictEqual(error.reason, "changed");
      assert.isTrue(test.reads.every((read) => read.fields.join() === "username"));
    });
  });
});
