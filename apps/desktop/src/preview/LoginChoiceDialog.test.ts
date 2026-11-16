import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as LoginChoiceDialog from "./LoginChoiceDialog.ts";

const owner = { id: 1 } as Electron.BrowserWindow;
const prompt = {
  type: "loginApproval" as const,
  threadId: "thread-1",
  requestId: "request-1",
  providerLabel: "Personal",
  origin: "https://app.rocketmoney.com",
  timeoutMs: 60_000,
  candidates: [
    {
      id: "first",
      title: "Rocket Money",
      username: "first@example.com",
      account: "Personal",
      vault: "Private",
      websites: ["https://app.rocketmoney.com/sign-in?from=home", "rocketaccount.com"],
    },
    {
      id: "second",
      title: "Rocket Money",
      username: "second@example.com",
      account: "Family",
      vault: "Shared",
      websites: ["https://app.rocketmoney.com", "https://rocketmoney.com/login"],
    },
    { id: "missing", title: "No username", username: "", websites: [] },
    { id: "unavailable", title: "Unknown username", websites: [] },
  ],
};

const setup = Effect.gen(function* () {
  const shown = yield* Queue.unbounded<{
    readonly input: ElectronMenu.ElectronMenuContextInput;
    readonly answer: (selection: Option.Option<string>) => void;
  }>();
  let closed = 0;
  let revealed = 0;
  let failed = false;
  const menuLayer = Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: () => Effect.void,
    popupTemplate: () => Effect.void,
    showContextMenu: (input) =>
      failed
        ? Effect.die(new Error("Native menu unavailable"))
        : Effect.callback((resume) => {
            Queue.offerUnsafe(shown, {
              input,
              answer: (selection) => resume(Effect.succeed(selection)),
            });
            return Effect.sync(() => {
              closed += 1;
            });
          }),
  });
  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.succeedSome(owner),
    currentMainOrFirst: Effect.succeedSome(owner),
    focusedMainOrFirst: Effect.succeedSome(owner),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () =>
      Effect.sync(() => {
        revealed += 1;
      }),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  });
  const choices = yield* LoginChoiceDialog.LoginChoiceDialog.pipe(
    Effect.provide(LoginChoiceDialog.layer.pipe(Layer.provide([menuLayer, windowLayer]))),
  );
  return {
    choices,
    shown,
    closed: () => closed,
    revealed: () => revealed,
    fail: () => {
      failed = true;
    },
  };
});

it.effect(
  "shows the destination and distinct username rows, then returns the second explicit choice",
  () =>
    Effect.gen(function* () {
      const { choices, shown, revealed } = yield* setup;
      const answer = yield* choices.choose(undefined, prompt).pipe(Effect.forkScoped);
      const popup = yield* Queue.take(shown);
      const header = popup.input.items[0];
      expect(header).toMatchObject({
        disabled: true,
        label: "Choose a login for https://app.rocketmoney.com",
      });
      expect(header?.header).not.toBe(true);
      const rows = popup.input.items.slice(1);
      expect(rows[0]?.label).toContain("Rocket Money");
      expect(rows[0]?.label).toContain("first@example.com");
      expect(rows[1]?.label).toContain("second@example.com");
      expect(rows[1]?.detail).toContain("Account: Family");
      expect(rows[1]?.detail).toContain("Vault: Shared");
      expect(rows[1]?.detail).toContain("https://rocketmoney.com");
      expect(rows[0]?.detail).not.toContain("from=home");
      expect(rows[0]?.detail).toContain("https://rocketaccount.com");
      expect(rows[2]?.label).toContain("No username saved");
      expect(rows[3]?.label).toContain("Username unavailable");
      expect(rows.every((row) => row.checked === undefined)).toBe(true);
      expect(revealed()).toBe(1);
      popup.answer(Option.some("second"));
      expect(yield* Fiber.join(answer)).toBe("second");
    }).pipe(Effect.scoped),
);

it.effect(
  "returns no selection on dismissal, unknown rows, cancellation, and deadline expiry",
  () => {
    const cancelled = new AbortController();
    return Effect.gen(function* () {
      const { choices, shown, closed, fail } = yield* setup;
      for (const result of [Option.none<string>(), Option.some("unknown")]) {
        const answer = yield* choices.choose(undefined, prompt).pipe(Effect.forkScoped);
        const popup = yield* Queue.take(shown);
        popup.answer(result);
        expect(yield* Fiber.join(answer)).toBeUndefined();
      }
      const aborted = yield* choices
        .choose(undefined, prompt, cancelled.signal)
        .pipe(Effect.forkScoped);
      const popup = yield* Queue.take(shown);
      cancelled.abort();
      expect(yield* Fiber.join(aborted)).toBeUndefined();
      expect(closed()).toBe(1);
      popup.answer(Option.some("second"));

      const expired = yield* choices
        .choose(undefined, { ...prompt, timeoutMs: 10.75 })
        .pipe(Effect.forkScoped);
      const late = yield* Queue.take(shown);
      yield* TestClock.adjust(11);
      expect(yield* Fiber.join(expired)).toBeUndefined();
      expect(closed()).toBe(2);
      late.answer(Option.some("second"));
      fail();
      expect(yield* Effect.exit(choices.choose(undefined, prompt))).toEqual(
        Exit.succeed(undefined),
      );
    }).pipe(Effect.scoped);
  },
);

it.effect("serializes requests and removes an aborted queued choice without opening it", () => {
  const cancelled = new AbortController();
  return Effect.gen(function* () {
    const { choices, shown } = yield* setup;
    const first = yield* choices.choose(undefined, prompt).pipe(Effect.forkScoped);
    const firstPopup = yield* Queue.take(shown);
    const second = yield* choices
      .choose(undefined, prompt, cancelled.signal)
      .pipe(Effect.forkScoped);
    cancelled.abort();
    expect(yield* Fiber.join(second)).toBeUndefined();
    expect(yield* Queue.size(shown)).toBe(0);
    firstPopup.answer(Option.some("first"));
    expect(yield* Fiber.join(first)).toBe("first");
  }).pipe(Effect.scoped);
});
