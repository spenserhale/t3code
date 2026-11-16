import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as LoginApprovalDialog from "./LoginApprovalDialog.ts";

const windows = Layer.succeed(ElectronWindow.ElectronWindow, {
  create: () => Effect.die("unexpected window creation"),
  main: Effect.succeedNone,
  currentMainOrFirst: Effect.succeedNone,
  focusedMainOrFirst: Effect.succeedNone,
  setMain: () => Effect.void,
  clearMain: () => Effect.void,
  prepareReveal: () => Effect.succeed(false),
  reveal: () => Effect.void,
  sendAll: () => Effect.void,
  destroyAll: Effect.void,
  syncAllAppearance: () => Effect.void,
} satisfies ElectronWindow.ElectronWindow["Service"]);

it.effect.each([120_000, 119_992.40869140625])(
  "shows login approval and returns the user's answer with %s milliseconds remaining",
  (timeoutMs) => {
    let shown = false;
    const dialog = Layer.succeed(ElectronDialog.ElectronDialog, {
      pickFolder: () => Effect.succeedNone,
      pickFiles: () => Effect.succeed([]),
      showMessageBox: (options) =>
        Effect.sync(() => {
          shown = true;
          assert.ok(options.signal);
          assert.equal(options.signal.aborted, false);
          return { response: 1, checkboxChecked: false };
        }),
      showErrorBox: () => Effect.void,
    } satisfies ElectronDialog.ElectronDialog["Service"]);

    return Effect.gen(function* () {
      const approvals = yield* LoginApprovalDialog.LoginApprovalDialog;
      const answer = yield* approvals.ask(undefined, {
        type: "loginApproval",
        threadId: "thread-1",
        requestId: "request-1",
        providerLabel: "Personal",
        origin: "https://example.com",
        timeoutMs,
      });
      assert.equal(shown, true);
      assert.equal(answer, "once");
    }).pipe(Effect.provide(LoginApprovalDialog.layer.pipe(Layer.provide([dialog, windows]))));
  },
);
