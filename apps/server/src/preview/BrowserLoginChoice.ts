import type { PreviewLoginChoice } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type * as SecretRelay from "../secrets/SecretRelay.ts";
import * as BrowserLogins from "./BrowserLogins.ts";
import type * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

interface ChoiceContext {
  readonly desktopChannel: Pick<
    DesktopBrowserChannel.DesktopBrowserChannel["Service"],
    "available" | "chooseLogin"
  >;
  readonly relay?: SecretRelay.SecretRelay["Service"] | undefined;
}

interface ChoiceRequest {
  readonly threadId: string;
  readonly tabId?: string | undefined;
  readonly origin: string;
  readonly threadTitle?: string | undefined;
  readonly agent?: string | undefined;
  readonly machine?: string | undefined;
  readonly deadline: number;
}

const refused = (message: string) =>
  new BrowserLogins.BrowserLoginError({ reason: "refused", message });

const needsChooser = () =>
  refused(
    "Choosing this login needs a connected SECode desktop app with login selection support. Connect or update the user's desktop app, then try again.",
  );

/** Asks only about metadata; this primitive never opens a password manager. */
export const choose = Effect.fn("BrowserLoginChoice.choose")(function* (
  context: ChoiceContext,
  request: ChoiceRequest & { readonly candidates: ReadonlyArray<PreviewLoginChoice> },
): Effect.fn.Return<string, BrowserLogins.BrowserLoginError> {
  const remaining = request.deadline - (yield* Clock.currentTimeMillis);
  if (remaining <= 0) return yield* refused("The call ended before a login was chosen.");
  if (request.candidates.length === 0) return yield* refused("There is no login to choose.");
  const { desktopChannel, relay } = context;
  let selected: string | undefined;
  if (desktopChannel.available && desktopChannel.chooseLogin !== undefined) {
    selected = yield* desktopChannel.chooseLogin(
      { threadId: request.threadId, ...(request.tabId ? { tabId: request.tabId } : {}) },
      Math.min(120_000, remaining),
      {
        providerLabel: [
          ...new Set(request.candidates.flatMap((item) => (item.account ? [item.account] : []))),
        ].join(", "),
        origin: request.origin,
        ...(request.threadTitle ? { threadTitle: request.threadTitle } : {}),
        ...(request.agent ? { agent: request.agent } : {}),
        ...(request.machine ? { machine: request.machine } : {}),
        candidates: request.candidates,
      },
    );
  } else if (relay !== undefined) {
    const answer = yield* relay
      .request(
        {
          kind: "loginChoice",
          threadId: request.threadId,
          origin: request.origin,
          ...(request.threadTitle ? { threadTitle: request.threadTitle } : {}),
          ...(request.agent ? { agent: request.agent } : {}),
          candidates: request.candidates,
        },
        Math.min(120_000, remaining),
      )
      .pipe(Effect.mapError(() => needsChooser()));
    if (answer.type === "values") selected = answer.item.id;
    else if (answer.type === "denied" && answer.message !== undefined)
      return yield* refused(answer.message);
    else if (answer.type !== "denied") return yield* needsChooser();
  } else {
    return yield* needsChooser();
  }
  if ((yield* Clock.currentTimeMillis) >= request.deadline) {
    return yield* refused("The call ended before a login was chosen.");
  }
  if (selected === undefined) return yield* refused("The user did not choose a login.");
  if (!request.candidates.some((candidate) => candidate.id === selected)) {
    return yield* refused("The chosen login was not one offered. Try again.");
  }
  return selected;
});

export interface SelectedLogin extends BrowserLogins.BrowserLoginCandidate {
  readonly userChosen?: boolean;
  /** A native choice permits writing only to this exact origin. */
  readonly fillOrigin?: string;
}

/** Selects before any password read; a single login saved for this site stays automatic. */
export const select = Effect.fn("BrowserLoginChoice.select")(function* (
  context: ChoiceContext & {
    readonly logins: Pick<BrowserLogins.BrowserLogins["Service"], "read" | "check">;
  },
  request: ChoiceRequest & {
    readonly revision: string;
    readonly candidates: ReadonlyArray<BrowserLogins.BrowserLoginCandidate>;
    readonly ready?: Effect.Effect<void, BrowserLogins.BrowserLoginError>;
    readonly checkPage?: Effect.Effect<void, BrowserLogins.BrowserLoginError>;
    readonly forceChoice?: boolean;
  },
): Effect.fn.Return<SelectedLogin | undefined, BrowserLogins.BrowserLoginError> {
  const check = Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) >= request.deadline) {
      return yield* refused("The call ended before a login was chosen.");
    }
    yield* context.logins.check(request.revision);
    if (request.checkPage !== undefined) yield* request.checkPage;
  });
  const [only] = request.candidates;
  if (only === undefined) return undefined;
  if (request.ready !== undefined) yield* request.ready;
  yield* check;
  if (
    !request.forceChoice &&
    request.candidates.length === 1 &&
    BrowserLogins.loginCoversPage(only.urls, request.origin)
  ) {
    return only;
  }
  const candidates = yield* Effect.forEach(request.candidates, (login) =>
    context.logins.read(request.revision, login, ["username"]).pipe(
      Effect.catchIf(
        (error) => error.reason === "unreadable" || error.reason === "not_configured",
        () => Effect.succeed({ username: undefined }),
      ),
      Effect.map((values): PreviewLoginChoice => ({
        id: login.id,
        title: login.title,
        account: login.account,
        ...(login.vault ? { vault: login.vault } : {}),
        ...(values.username === undefined ? {} : { username: values.username }),
        websites: login.urls,
      })),
    ),
  );
  yield* check;
  const selected = yield* choose(context, { ...request, candidates });
  yield* check;
  const login = request.candidates.find((candidate) => candidate.id === selected)!;
  return {
    ...login,
    userChosen: true,
    ...(BrowserLogins.loginCoversPage(login.urls, request.origin)
      ? {}
      : { fillOrigin: request.origin }),
  };
});
