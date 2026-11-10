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

/** Allow once, allow for this thread, or false for Deny. */
export type LoginApprovalAnswer = "once" | "thread" | false;

export class LoginApprovalDialog extends Context.Service<
  LoginApprovalDialog,
  {
    /**
     * Asks the user before an agent's tab is filled with a saved login or identity, before an
     * identity is shown to the agent, or before either is sent to another machine. Closing the
     * dialog, or `cancelled` aborting, is a Deny. `guest` is absent for a tab the desktop does not
     * show, such as an agent's headless tab, and for a request with no tab.
     */
    readonly ask: (
      guest: WebContents | undefined,
      prompt: LoginApprovalPrompt,
      cancelled?: AbortSignal,
    ) => Effect.Effect<LoginApprovalAnswer>;
  }
>()("@t3tools/desktop/preview/LoginApprovalDialog") {}

type ApprovalKind = NonNullable<LoginApprovalPrompt["kind"]>;

const THREAD_NOTE: Record<ApprovalKind, string> = {
  login: "Allow for this thread lets it fill saved logins until the app restarts.",
  identity: "Allow for this thread lets it fill saved identities until the app restarts.",
  identityRead: "Allow for this thread lets it see saved identities until the app restarts.",
  newLogin:
    "Allow for this thread lets it create logins and fill their passwords until the app restarts.",
};

const ANSWERS: ReadonlyArray<LoginApprovalAnswer> = [false, "once", "thread"];

const wording = (prompt: LoginApprovalPrompt, who: string) => {
  const site = prompt.origin ?? "a website";
  const vault = prompt.vault ? ` (${prompt.vault})` : "";
  const from = prompt.providerLabel;
  // A relayed request sends the item to another machine, which fills it or shows it there.
  const to = prompt.machine;
  // Asked before anything is read, the item is named by title only when that was known already.
  const item =
    prompt.loginTitle !== undefined
      ? `"${prompt.loginTitle}"${vault}`
      : prompt.reference !== undefined
        ? prompt.reference
        : undefined;
  switch (prompt.kind ?? "login") {
    case "login":
      return {
        message:
          to === undefined ? `Fill a login from ${from}?` : `Send a login from ${from} to ${to}?`,
        detail: [
          `${who} wants to sign in to ${site}${item === undefined ? "" : ` with ${item}`}.`,
          "The agent will not see the password or code.",
        ],
      };
    case "identity":
      return {
        message:
          to === undefined
            ? `Fill an identity from ${from}?`
            : `Send an identity from ${from} to ${to}?`,
        detail: [
          `${who} wants to fill ${item === undefined ? "an identity" : `identity ${item}`} from ${from} into ${site}.`,
          "The agent can read the filled fields.",
        ],
      };
    case "identityRead":
      return {
        message: `Show an identity from ${from} to the agent${to === undefined ? "" : ` on ${to}`}?`,
        detail: [
          `${who} wants to see ${item === undefined ? "an identity" : `identity ${item}`} from ${from}.`,
          "The agent will see your name, birth date, email, phone and address, and so will its model provider.",
        ],
      };
    case "newLogin":
      return {
        message: `Create a new login for ${site} in ${from}${
          prompt.vault ? ` / ${prompt.vault}` : ""
        } and fill its generated password?`,
        detail: [
          `${who} is signing up and wants ${prompt.loginTitle === undefined ? "a login" : `"${prompt.loginTitle}"`} saved with a generated password before the form is sent.`,
          "The agent will not see the password.",
        ],
      };
  }
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
    ask: Effect.fn("LoginApprovalDialog.ask")(function* (guest, prompt, cancelled) {
      const agent = [prompt.agent, prompt.threadTitle ? `"${prompt.threadTitle}"` : undefined]
        .filter(Boolean)
        .join(" in ");
      const who = `${agent || "An agent"}${prompt.machine === undefined ? "" : ` on ${prompt.machine}`}`;
      const { message, detail } = wording(prompt, who);
      const expiresAt = (yield* Clock.currentTimeMillis) + prompt.timeoutMs;
      // Prompts queue behind each other; one whose call has ended is never shown, and an open one
      // closes as a Deny when the server stops waiting.
      return yield* oneAtATime.withPermits(1)(
        Effect.gen(function* () {
          const remaining = expiresAt - (yield* Clock.currentTimeMillis);
          if (remaining <= 0 || cancelled?.aborted) return false;
          const owner =
            hostWindow(guest) ?? Option.getOrUndefined(yield* windows.focusedMainOrFirst);
          const { response } = yield* dialog.showMessageBox(
            {
              signal: AbortSignal.any([
                AbortSignal.timeout(remaining),
                ...(cancelled === undefined ? [] : [cancelled]),
              ]),
              type: "question",
              buttons: ["Deny", "Allow once", "Allow for this thread"],
              // Deny by default, so an Enter typed into the page cannot approve.
              defaultId: 0,
              cancelId: 0,
              noLink: true,
              message,
              detail: [...detail, THREAD_NOTE[prompt.kind ?? "login"]].join("\n\n"),
            },
            owner,
          );
          const late = (yield* Clock.currentTimeMillis) >= expiresAt || cancelled?.aborted;
          return late ? false : (ANSWERS[response] ?? false);
        }).pipe(Effect.orElseSucceed((): LoginApprovalAnswer => false)),
      );
    }),
  });
});

export const layer = Layer.effect(LoginApprovalDialog, make);
