import type {
  DesktopBrowserCommand,
  DesktopSecretApproval,
  DesktopSecretApprovalAnswer,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { MessageChannelMain, type WebContents } from "electron";

import { SECRET_APPROVAL_CHANNEL } from "../ipc/channels.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

export type LoginApprovalPrompt = Extract<
  DesktopBrowserCommand,
  { readonly type: "loginApproval" }
>;

/** Allow once, allow for this thread, or false for Deny. */
export type LoginApprovalAnswer = DesktopSecretApprovalAnswer;

export class LoginApprovalDialog extends Context.Service<
  LoginApprovalDialog,
  {
    /**
     * Asks before an agent's tab is filled with a saved login or identity, an identity is shown to
     * the agent, a secret goes to its command, or any of these goes to another machine. Closing the
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
  secretReference:
    "Allow for this thread lets it use any saved secret in its commands until the app restarts.",
};

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
          "Allow once includes the password and saved one-time code for this sign-in in the same tab and site for five minutes.",
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
    case "secretReference":
      return {
        message:
          to === undefined
            ? `Use a secret from ${from} in a command?`
            : `Send a secret from ${from} to ${to}?`,
        detail: [
          `${who} wants to use ${item ?? "a secret"} in a command.`,
          "The agent will not see it. The command gets it as input or in its environment, and its output comes back with it masked.",
        ],
      };
  }
};

const make = Effect.gen(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;
  return LoginApprovalDialog.of({
    ask: Effect.fn("LoginApprovalDialog.ask")(function* (_guest, prompt, cancelled) {
      const expiresAt = (yield* Clock.currentTimeMillis) + prompt.timeoutMs;
      const owner = Option.getOrUndefined(yield* windows.main);
      if (!owner || cancelled?.aborted || prompt.timeoutMs <= 0) return false;
      const threadLabel = prompt.threadTitle || prompt.threadId;
      const who = `${prompt.agent || "An agent"} in "${threadLabel}"${prompt.machine ? ` on ${prompt.machine}` : ""}`;
      const card: DesktopSecretApproval = {
        ...wording(prompt, who),
        threadId: prompt.threadId,
        threadLabel: prompt.machine ? `${threadLabel} on ${prompt.machine}` : threadLabel,
        ...(prompt.kind === "secretReference" && prompt.command ? { command: prompt.command } : {}),
        threadNote: THREAD_NOTE[prompt.kind ?? "login"],
      };
      // Transfer the reply port only to the app's main frame. Each port answers exactly one request.
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => new MessageChannelMain()),
        ({ port1, port2 }) =>
          Effect.callback<LoginApprovalAnswer>((resume) => {
            const finish = (answer: LoginApprovalAnswer) => {
              cancelled?.removeEventListener("abort", deny);
              resume(Effect.succeed(answer));
            };
            const deny = () => finish(false);
            port1.once("message", ({ data }) =>
              finish(data === "once" || data === "thread" ? data : false),
            );
            port1.once("close", deny);
            port1.start();
            if (cancelled?.aborted) {
              deny();
              return;
            }
            cancelled?.addEventListener("abort", deny, { once: true });
            try {
              owner.webContents.mainFrame.postMessage(SECRET_APPROVAL_CHANNEL, card, [port2]);
            } catch {
              deny();
            }
            return Effect.sync(() => cancelled?.removeEventListener("abort", deny));
          }),
        ({ port1 }) =>
          Effect.sync(() => {
            port1.postMessage("closed");
            port1.close();
          }),
      ).pipe(Effect.timeoutOption(prompt.timeoutMs));
      return cancelled?.aborted || (yield* Clock.currentTimeMillis) >= expiresAt
        ? false
        : Option.getOrElse(result, () => false as const);
    }),
  });
});

export const layer = Layer.effect(LoginApprovalDialog, make);
