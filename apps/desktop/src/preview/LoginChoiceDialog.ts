import type { DesktopBrowserCommand, PreviewLoginChoice } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { BrowserWindow, type WebContents } from "electron";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

type LoginChoicePrompt = Extract<DesktopBrowserCommand, { readonly type: "loginApproval" }> & {
  readonly candidates: ReadonlyArray<PreviewLoginChoice>;
};

export class LoginChoiceDialog extends Context.Service<
  LoginChoiceDialog,
  {
    readonly choose: (
      guest: WebContents | undefined,
      prompt: LoginChoicePrompt,
      cancelled?: AbortSignal,
    ) => Effect.Effect<string | undefined>;
  }
>()("@t3tools/desktop/preview/LoginChoiceDialog") {}

const hostWindow = (guest: WebContents | undefined) => {
  if (guest === undefined || guest.isDestroyed()) return undefined;
  const host = guest.hostWebContents ?? guest;
  return host.isDestroyed() ? undefined : (BrowserWindow.fromWebContents(host) ?? undefined);
};

const websiteOrigins = (websites: ReadonlyArray<string>) => {
  const origins = websites.flatMap((website) => {
    try {
      const url = new URL(website.includes("://") ? website : `https://${website}`);
      return url.protocol === "http:" || url.protocol === "https:" ? [url.origin] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(origins)].join(", ") || "Unavailable";
};

const make = Effect.gen(function* () {
  const dialog = yield* ElectronDialog.ElectronDialog;
  const windows = yield* ElectronWindow.ElectronWindow;
  const oneAtATime = yield* Semaphore.make(1);
  return LoginChoiceDialog.of({
    choose: Effect.fn("LoginChoiceDialog.choose")(function* (guest, prompt, cancelled) {
      if (prompt.candidates.length === 0 || !prompt.origin || cancelled?.aborted) return undefined;
      const expiresAt = (yield* Clock.currentTimeMillis) + prompt.timeoutMs;
      const choose = oneAtATime.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Clock.currentTimeMillis) >= expiresAt || cancelled?.aborted) return undefined;
          const owner =
            hostWindow(guest) ?? Option.getOrUndefined(yield* windows.focusedMainOrFirst);
          if (owner === undefined) return undefined;
          yield* windows.reveal(owner);
          const requester = [
            prompt.agent,
            ...(prompt.threadTitle ? [`Thread: ${prompt.threadTitle}`] : []),
            ...(prompt.machine ? [`Machine: ${prompt.machine}`] : []),
          ]
            .filter(Boolean)
            .join(" · ");
          // Numbered, so two items with the same title and username stay distinguishable.
          const rows = prompt.candidates.map(
            (candidate, index) =>
              `${index + 1}. ${candidate.title}: ${candidate.username === undefined ? "Username unavailable" : candidate.username || "No username saved"}`,
          );
          // A window sheet, not a pointer menu: an unprompted menu opens wherever the pointer is
          // and any click elsewhere closes it as no choice.
          const { response } = yield* Effect.gen(function* () {
            const close = yield* Effect.abortSignal;
            return yield* dialog.showMessageBox(
              {
                signal: cancelled === undefined ? close : AbortSignal.any([close, cancelled]),
                type: "question",
                buttons: ["Cancel", ...rows],
                // Cancel by default, so an Enter typed into the page cannot pick a login.
                defaultId: 0,
                cancelId: 0,
                message: `Choose a login for ${prompt.origin}`,
                detail: [
                  ...(requester ? [requester] : []),
                  ...prompt.candidates.map((candidate, index) =>
                    [
                      rows[index],
                      [
                        `Account: ${candidate.account ?? "Unavailable"}`,
                        `Vault: ${candidate.vault ?? "Unavailable"}`,
                        `Websites: ${websiteOrigins(candidate.websites)}`,
                      ].join(" · "),
                    ].join("\n"),
                  ),
                ].join("\n\n"),
              },
              owner,
            );
          }).pipe(Effect.scoped);
          if ((yield* Clock.currentTimeMillis) >= expiresAt || cancelled?.aborted) return undefined;
          return response > 0 ? prompt.candidates[response - 1]?.id : undefined;
        }),
      );
      const abort =
        cancelled === undefined
          ? Effect.never
          : Effect.callback<undefined>((resume) => {
              const stop = () => resume(Effect.undefined);
              cancelled.addEventListener("abort", stop, { once: true });
              if (cancelled.aborted) stop();
              return Effect.sync(() => cancelled.removeEventListener("abort", stop));
            });
      return yield* Effect.raceFirst(choose, abort).pipe(
        Effect.timeoutOption(Math.max(0, prompt.timeoutMs)),
        Effect.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.undefined),
      );
    }),
  });
});

export const layer = Layer.effect(LoginChoiceDialog, make);
