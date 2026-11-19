// @effect-diagnostics nodeBuiltinImport:off -- The test port implements Electron's event interface.
import * as NodeEvents from "node:events";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { DesktopSecretApproval } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as LoginApprovalDialog from "./LoginApprovalDialog.ts";

class TestPort extends NodeEvents.EventEmitter {
  start = vi.fn();
  close = vi.fn();
  postMessage = vi.fn();
}

vi.mock("electron", () => ({
  MessageChannelMain: class {
    port1 = new TestPort();
    port2 = { peer: this.port1 };
  },
}));

const setup = Effect.gen(function* () {
  const shown = yield* Queue.unbounded<{ card: DesktopSecretApproval; port: TestPort }>();
  const mainFrame = {
    postMessage: (_channel: string, card: DesktopSecretApproval, ports: [{ peer: TestPort }]) =>
      Queue.offerUnsafe(shown, { card, port: ports[0].peer }),
  };
  const owner = { webContents: { mainFrame } } as unknown as Electron.BrowserWindow;
  const approvals = yield* LoginApprovalDialog.LoginApprovalDialog.pipe(
    Effect.provide(LoginApprovalDialog.layer),
    Effect.provideService(ElectronWindow.ElectronWindow, {
      create: () => Effect.die("unexpected window creation"),
      main: Effect.succeedSome(owner),
      currentMainOrFirst: Effect.succeedNone,
      focusedMainOrFirst: Effect.succeedNone,
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      prepareReveal: () => Effect.succeed(false),
      reveal: () => Effect.void,
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    }),
  );
  const ask = (cancelled?: AbortSignal) =>
    approvals.ask(
      undefined,
      {
        type: "loginApproval",
        threadId: "thread-1",
        requestId: "request-1",
        providerLabel: "Personal",
        origin: "https://example.com",
        timeoutMs: 119_992.40869140625,
      },
      cancelled,
    );
  return { ask, shown };
});

it.effect.each(["once", "thread", false, "invalid"] as const)(
  "handles %s on its request port",
  (answer) =>
    Effect.gen(function* () {
      const { ask, shown } = yield* setup;
      const waiting = yield* ask().pipe(Effect.forkChild);
      const { card, port } = yield* Queue.take(shown);
      assert.include(card.detail.join(" "), "same tab and site for five minutes");
      port.emit("message", { data: answer });
      assert.equal(yield* Fiber.join(waiting), answer === "invalid" ? false : answer);
      assert.equal(port.close.mock.calls.length, 1);
    }),
);

it.effect.each(["cancel", "timeout", "disconnect"])(
  "withdraws on %s and ignores late approval",
  (reason) =>
    Effect.gen(function* () {
      const { ask, shown } = yield* setup;
      // @effect-diagnostics-next-line abortControllerInEffect:off -- The server cancels this request independently of its desktop fiber.
      const controller = new AbortController();
      const waiting = yield* ask(controller.signal).pipe(Effect.forkChild);
      const { port } = yield* Queue.take(shown);
      if (reason === "cancel") controller.abort();
      if (reason === "timeout") yield* TestClock.adjust(120_000);
      if (reason === "disconnect") port.emit("close");
      port.emit("message", { data: "thread" });
      assert.equal(yield* Fiber.join(waiting), false);
      assert.deepEqual(port.postMessage.mock.calls, [["closed"]]);
      assert.equal(port.close.mock.calls.length, 1);
    }),
);
