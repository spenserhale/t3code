import type { DesktopBrowserCommand } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { BrowserWindow, type WebContents } from "electron";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

export type LoginApprovalPrompt = Extract<
  DesktopBrowserCommand,
  { readonly type: "loginApproval" }
>;

export class LoginApprovalDialog extends Context.Service<
  LoginApprovalDialog,
  {
    /**
     * Asks the user before an agent's tab is filled with a saved login; anything but Allow is a no.
     * `guest` is absent for a tab the desktop does not show, such as an agent's headless tab.
     */
    readonly ask: (
      guest: WebContents | undefined,
      prompt: LoginApprovalPrompt,
    ) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/preview/LoginApprovalDialog") {}

const SCOPE_NOTE: Record<LoginApprovalPrompt["scope"], string> = {
  request: "You will be asked again for every login.",
  thread: "Allowing lets this thread fill saved logins until the app restarts.",
  application: "Allowing lets every thread fill saved logins until the app restarts.",
};

const hostWindow = (guest: WebContents | undefined) => {
  if (guest === undefined || guest.isDestroyed()) return undefined;
  const host = guest.hostWebContents ?? guest;
  return host.isDestroyed() ? undefined : (BrowserWindow.fromWebContents(host) ?? undefined);
};

const make = Effect.gen(function* () {
  const dialog = yield* ElectronDialog.ElectronDialog;
  const windows = yield* ElectronWindow.ElectronWindow;
  // Several threads may ask at once; one dialog at a time keeps each answer tied to its prompt.
  const oneAtATime = yield* Semaphore.make(1);
  return LoginApprovalDialog.of({
    ask: Effect.fn("LoginApprovalDialog.ask")(function* (guest, prompt) {
      const who = [prompt.agent, prompt.threadTitle ? `"${prompt.threadTitle}"` : undefined]
        .filter(Boolean)
        .join(" in ");
      const detail = [
        `${who || "An agent"} wants to sign in to ${prompt.origin} with "${prompt.loginTitle}"${
          prompt.vault ? ` from ${prompt.vault}` : ""
        }.`,
        "The agent will not see the password or code.",
        SCOPE_NOTE[prompt.scope],
      ].join("\n\n");
      const expiresAt = (yield* Clock.currentTimeMillis) + prompt.timeoutMs;
      // Prompts queue behind each other; one whose call has ended is never shown, and an open one
      // closes as a Deny when the server stops waiting.
      return yield* oneAtATime.withPermits(1)(
        Effect.gen(function* () {
          const remaining = expiresAt - (yield* Clock.currentTimeMillis);
          if (remaining <= 0) return false;
          const owner =
            hostWindow(guest) ?? Option.getOrUndefined(yield* windows.focusedMainOrFirst);
          const { response } = yield* dialog.showMessageBox(
            {
              signal: AbortSignal.timeout(remaining),
              type: "question",
              buttons: ["Allow", "Deny"],
              // Deny by default, so an Enter typed into the page cannot approve.
              defaultId: 1,
              cancelId: 1,
              noLink: true,
              message: `Fill a ${prompt.providerLabel} login?`,
              detail,
            },
            owner,
          );
          return response === 0 && (yield* Clock.currentTimeMillis) < expiresAt;
        }).pipe(Effect.orElseSucceed(() => false)),
      );
    }),
  });
});

export const layer = Layer.effect(LoginApprovalDialog, make);
