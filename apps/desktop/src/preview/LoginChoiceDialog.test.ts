import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
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
    readonly options: Electron.MessageBoxOptions;
    readonly owner: Electron.BrowserWindow | undefined;
    readonly answer: (response: number) => void;
  }>();
  let closed = 0;
  let revealed = 0;
  let failed = false;
  const dialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.succeedNone,
    pickFiles: () => Effect.succeed([]),
    showErrorBox: () => Effect.void,
    // Like Electron's, an aborted signal closes an open box as if Cancel were pressed.
    showMessageBox: (options, window) =>
      failed
        ? Effect.die(new Error("Native dialog unavailable"))
        : Effect.callback((resume) => {
            let open = true;
            const answer = (response: number) => {
              if (!open) return;
              open = false;
              resume(Effect.succeed({ response, checkboxChecked: false }));
            };
            options.signal?.addEventListener(
              "abort",
              () => {
                if (!open) return;
                closed += 1;
                answer(options.cancelId ?? 0);
              },
              { once: true },
            );
            Queue.offerUnsafe(shown, { options, owner: window, answer });
          }),
  } satisfies ElectronDialog.ElectronDialog["Service"]);
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
    Effect.provide(LoginChoiceDialog.layer.pipe(Layer.provide([dialogLayer, windowLayer]))),
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
  "asks in a sheet on the window with the destination and distinct rows, then returns the second explicit choice",
  () =>
    Effect.gen(function* () {
      const { choices, shown, revealed } = yield* setup;
      const answer = yield* choices
        .choose(undefined, {
          ...prompt,
          agent: "Codex",
          threadTitle: "Monthly Budget",
          machine: "LinkMini",
        })
        .pipe(Effect.forkScoped);
      const box = yield* Queue.take(shown);
      expect(box.owner).toBe(owner);
      expect(revealed()).toBe(1);
      expect(box.options).toMatchObject({
        message: "Choose a login for https://app.rocketmoney.com",
        buttons: [
          "Cancel",
          "1. Rocket Money: first@example.com",
          "2. Rocket Money: second@example.com",
          "3. No username: No username saved",
          "4. Unknown username: Username unavailable",
        ],
        defaultId: 0,
        cancelId: 0,
      });
      const [requester, first, second] = box.options.detail?.split("\n\n") ?? [];
      expect(requester).toContain("Codex");
      expect(requester).toContain("Monthly Budget");
      expect(requester).toContain("LinkMini");
      expect(first).toContain("https://rocketaccount.com");
      expect(first).not.toContain("from=home");
      expect(second).toContain("Account: Family");
      expect(second).toContain("Vault: Shared");
      expect(second).toContain("https://rocketmoney.com");
      box.answer(2);
      expect(yield* Fiber.join(answer)).toBe("second");
    }).pipe(Effect.scoped),
);

it.effect(
  "returns no selection on Cancel, unknown buttons, cancellation, deadline expiry, and failure",
  () => {
    const cancelled = new AbortController();
    return Effect.gen(function* () {
      const { choices, shown, closed, fail } = yield* setup;
      for (const response of [0, 9]) {
        const answer = yield* choices.choose(undefined, prompt).pipe(Effect.forkScoped);
        const box = yield* Queue.take(shown);
        box.answer(response);
        expect(yield* Fiber.join(answer)).toBeUndefined();
      }
      expect(closed()).toBe(0);
      const aborted = yield* choices
        .choose(undefined, prompt, cancelled.signal)
        .pipe(Effect.forkScoped);
      const box = yield* Queue.take(shown);
      cancelled.abort();
      expect(yield* Fiber.join(aborted)).toBeUndefined();
      expect(closed()).toBe(1);
      box.answer(2);

      const expired = yield* choices
        .choose(undefined, { ...prompt, timeoutMs: 10.75 })
        .pipe(Effect.forkScoped);
      const late = yield* Queue.take(shown);
      yield* TestClock.adjust(11);
      expect(yield* Fiber.join(expired)).toBeUndefined();
      expect(closed()).toBe(2);
      late.answer(2);
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
    const firstBox = yield* Queue.take(shown);
    const second = yield* choices
      .choose(undefined, prompt, cancelled.signal)
      .pipe(Effect.forkScoped);
    cancelled.abort();
    expect(yield* Fiber.join(second)).toBeUndefined();
    expect(yield* Queue.size(shown)).toBe(0);
    firstBox.answer(1);
    expect(yield* Fiber.join(first)).toBe("first");
  }).pipe(Effect.scoped);
});
