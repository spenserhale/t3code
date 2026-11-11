/**
 * The one order every secret request follows: an item a `choose` named goes only to its provider;
 * else this machine's service accounts, then (unless set to refuse) its attended providers once its
 * desktop app asked, then the user's device, else a refusal. A missing source passes it on; only a
 * Deny or an unreadable named item stops it, and values return only under the starting settings.
 */
import {
  type BrowserSecretEscalation,
  type PreviewLoginCandidate,
  SECRET_RELAY_DEVICE_PREFIX,
  type SecretRelayAnswer,
  type SecretRelayItem,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type * as SecretRelay from "../secrets/SecretRelay.ts";
import * as BrowserLogins from "./BrowserLogins.ts";
import type * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import { loginError } from "./ServerBrowserLogin.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

export interface SecretAccessServices {
  readonly logins: Pick<
    BrowserLogins.BrowserLogins["Service"],
    "escalation" | "needsApproval" | "recordApproval" | "check"
  >;
  readonly desktopChannel: Pick<
    DesktopBrowserChannel.DesktopBrowserChannel["Service"],
    "available" | "approveLogin"
  >;
  readonly relay: SecretRelay.SecretRelay["Service"] | undefined;
}

/** The services, and runners for one call's steps from Playwright code. */
export interface SecretAccessContext extends SecretAccessServices {
  /** Runs a step; its failure becomes an operation error. */
  readonly step: <A>(effect: Effect.Effect<A, BrowserLogins.BrowserLoginError>) => Promise<A>;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
  /** Aborted once nobody waits for the call; steps begun under it are interrupted with it. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Runners bound to one call, so a caller that gives up interrupts what it began: the dialog closes
 * and a relayed request ends on the user's device.
 */
export const callRunners = (
  run: <A, E>(effect: Effect.Effect<A, E>, options?: Effect.RunOptions) => Promise<A>,
  signal: AbortSignal | undefined,
): Pick<SecretAccessContext, "step" | "runPromise" | "signal"> => ({
  signal,
  runPromise: (effect) => run(effect, { signal }),
  step: (effect) =>
    run(
      effect.pipe(
        Effect.mapError((error) =>
          error.cause instanceof ServerBrowserPage.ServerBrowserOperationError
            ? error.cause
            : loginError(error.message),
        ),
        Effect.catchDefect(() => Effect.fail(loginError("The password manager failed."))),
      ),
      { signal },
    ),
});

/** A page check run inside the order; its failure ends the request as it was thrown. */
export const pageStep = (check: () => Promise<void>) =>
  Effect.tryPromise({
    try: check,
    catch: (cause) => {
      const error = ServerBrowserPage.toOperationError(cause);
      return new BrowserLogins.BrowserLoginError({
        reason: "refused",
        message: error.message,
        cause: error,
      });
    },
  });

/** What every item has, wherever it was found. */
export interface SecretItem {
  readonly id: string;
  readonly title: string;
  readonly vault?: string | undefined;
  readonly account?: string | undefined;
}

export interface SecretRequest {
  readonly kind: BrowserLogins.BrowserApprovalKind;
  readonly threadId: string;
  readonly threadTitle?: string | undefined;
  readonly agent?: string | undefined;
  /** The tab a fill goes into, so the desktop app asks in the window showing it. */
  readonly tabId?: string | undefined;
  /** The page a fill goes into. */
  readonly origin?: string | undefined;
  /** An id from an earlier `choose`: `<providerId>/<itemId>`, or a `device:` id. */
  readonly item?: string | undefined;
  /** An item the user named, such as `op://Vault/Item`. */
  readonly reference?: string | undefined;
  /** When the call ends, in `Clock` time. */
  readonly deadline: number;
  /**
   * Runs once, before the first item is read and before anyone is asked, so a page that cannot
   * take the values bothers no one. Its failure ends the request.
   */
  readonly ready?: Effect.Effect<void, BrowserLogins.BrowserLoginError> | undefined;
}

/** One kind of item: where the request finds it, how it is read, and how a device is asked. */
export interface SecretCatalog<Item extends SecretItem, Values> {
  /** What a refusal names, such as "a login for https://example.com"; a reference names itself. */
  readonly what: string;
  /** The items the request may mean in the providers of `reach`, found without reading any. */
  readonly find: (
    reach: BrowserLogins.BrowserLoginReach,
  ) => Effect.Effect<ReadonlyArray<Item>, BrowserLogins.BrowserLoginError>;
  readonly read: (
    revision: string,
    item: Item,
  ) => Effect.Effect<Values, BrowserLogins.BrowserLoginError>;
  /** Why an item found here cannot serve the request, such as a login saved for another site. */
  readonly unusable?: (item: Item) => string | undefined;
  /**
   * What values read for an item lack, such as the one-time code asked for. An item the request
   * did not name is then passed over for the next source; a named one is returned as it was read.
   */
  readonly lacks?: (item: SecretItem, values: Values) => string | undefined;
  /** How the user's device is asked; absent for what is never relayed. */
  readonly relay?: {
    /** The request, less the item or reference the order adds. */
    readonly ask: SecretRelay.SecretRelayAsk;
    readonly values: (values: Readonly<Record<string, string>>) => Values;
  };
  /** What the dialog names when the catalog knows it before anything is read. */
  readonly prompt?: Partial<
    Pick<DesktopBrowserChannel.DesktopLoginPrompt, "providerLabel" | "loginTitle" | "vault">
  >;
  /** The refusal when nobody could be asked, where the general one does not fit. */
  readonly refusal?: (escalation: BrowserSecretEscalation) => string;
}

interface SecretFound<Item, Values> {
  readonly status: "found";
  readonly revision: string;
  readonly item: Item | SecretRelayItem;
  readonly values: Values;
}

export type SecretAccess<Item, Values> =
  | SecretFound<Item, Values>
  | { readonly status: "choose"; readonly candidates: ReadonlyArray<PreviewLoginCandidate> }
  | { readonly status: "none" };

/** Why nobody could answer, in words an agent can pass on to the user. */
const refusalMessage = (what: string, escalation: BrowserSecretEscalation) =>
  `No service account on this machine can open ${what}, and ${
    escalation === "refuse"
      ? "this machine is set not to ask the user's device"
      : "no T3 Code desktop app that can ask the user is connected"
  }. It needs Touch ID on a connected Mac, or a service account on this machine with access to that item.`;

const ASKED_FOR: Record<BrowserLogins.BrowserApprovalKind, string> = {
  login: "this login",
  identity: "filling this identity",
  identityRead: "showing this identity",
  newLogin: "this new login",
};

const refused = (message: string) =>
  new BrowserLogins.BrowserLoginError({ reason: "refused", message });

const denied = (kind: BrowserLogins.BrowserApprovalKind, where = "") =>
  refused(`The user did not approve ${ASKED_FOR[kind]}${where}.`);

const unreadable = (id: string, why?: string) =>
  refused(
    `That item (${id}) could not be read; choose again.${why === undefined ? "" : ` ${why}`}`,
  );

/** A source that is missing or cannot answer, as opposed to a refusal or changed settings. */
const sourceFailed = (error: BrowserLogins.BrowserLoginError) =>
  error.reason === "unreadable" || error.reason === "not_configured";

export const summary = (item: SecretItem): PreviewLoginCandidate => ({
  id: item.id,
  title: item.title,
  ...(item.vault ? { vault: item.vault } : {}),
  ...(item.account ? { account: item.account } : {}),
});

/** A relayed answer's values, unwrapped only where they are filled or handed over. */
const relayedValues = (
  values: Readonly<Record<string, Redacted.Redacted<string>>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Redacted.value(value)]));

type DeviceAnswer = SecretRelayAnswer | { readonly type: "no_device" };

export const resolve = Effect.fn("BrowserSecretAccess.resolve")(function* <
  Item extends SecretItem,
  Values,
>(
  services: SecretAccessServices,
  request: SecretRequest,
  catalog: SecretCatalog<Item, Values>,
): Effect.fn.Return<SecretAccess<Item, Values>, BrowserLogins.BrowserLoginError> {
  const { logins, desktopChannel, relay } = services;
  // Every later step runs under these settings; one that changed in between fails.
  const { revision, escalation, providers } = yield* logins.escalation;
  const what = request.reference ?? catalog.what;
  // What an item passed over lacked, which says more than any refusal once nobody else answers.
  let lacking: string | undefined;
  const refusal = () =>
    refused(lacking ?? catalog.refusal?.(escalation) ?? refusalMessage(what, escalation));

  let readied = false;
  const ready = Effect.suspend(() => {
    if (readied || request.ready === undefined) return Effect.void;
    readied = true;
    return request.ready;
  });

  const found = (item: Item | SecretRelayItem, values: Values) =>
    logins
      .check(revision)
      .pipe(Effect.as<SecretFound<Item, Values>>({ status: "found", revision, item, values }));

  const read = Effect.fn("BrowserSecretAccess.read")(function* (item: Item) {
    const unusable = catalog.unusable?.(item);
    if (unusable !== undefined) return yield* refused(unusable);
    yield* ready;
    return yield* found(item, yield* catalog.read(revision, item));
  });

  /** A choice among several items, the one there is read, or undefined when there is none. */
  const take = Effect.fn("BrowserSecretAccess.take")(function* (
    reach: BrowserLogins.BrowserLoginReach,
  ): Effect.fn.Return<SecretAccess<Item, Values> | undefined, BrowserLogins.BrowserLoginError> {
    const items = yield* catalog.find(reach);
    if (items.length > 1) return { status: "choose", candidates: items.map(summary) };
    const [item] = items;
    if (item === undefined) return undefined;
    const access = yield* read(item);
    lacking = catalog.lacks?.(item, access.values);
    return lacking === undefined ? access : undefined;
  });

  /** This machine's dialog, unless the user allowed this kind for the thread; Deny stops all. */
  const approve = Effect.fn("BrowserSecretAccess.approve")(function* (providerLabel: string) {
    yield* ready;
    const scope = { threadId: request.threadId };
    if (!(yield* logins.needsApproval(revision, scope, request.kind))) return;
    const answer = yield* desktopChannel.approveLogin(
      { threadId: request.threadId, ...(request.tabId ? { tabId: request.tabId } : {}) },
      Math.max(0, request.deadline - (yield* Clock.currentTimeMillis)),
      {
        kind: request.kind,
        providerLabel,
        ...catalog.prompt,
        ...(request.reference ? { reference: request.reference } : {}),
        ...(request.origin ? { origin: request.origin } : {}),
        ...(request.threadTitle ? { threadTitle: request.threadTitle } : {}),
        ...(request.agent ? { agent: request.agent } : {}),
      },
    );
    if (answer === false) return yield* denied(request.kind);
    if ((yield* Clock.currentTimeMillis) >= request.deadline) {
      return yield* refused("The approval came after the call ended.");
    }
    if (answer === "thread") yield* logins.recordApproval(revision, scope, request.kind);
  });

  const askDevice = Effect.fn("BrowserSecretAccess.askDevice")(function* (target: {
    readonly item?: string;
    readonly reference?: string;
  }): Effect.fn.Return<DeviceAnswer, BrowserLogins.BrowserLoginError> {
    const relayed = catalog.relay;
    if (relayed === undefined || relay === undefined) return { type: "no_device" };
    yield* ready;
    return yield* relay
      .request(
        { ...relayed.ask, ...target },
        Math.max(0, request.deadline - (yield* Clock.currentTimeMillis)),
        // A device that answers without checking must not end the request for one that has it.
        target.item === undefined
          ? ({ item, values }) =>
              catalog.lacks?.(item, relayed.values(relayedValues(values))) === undefined
          : undefined,
      )
      .pipe(
        Effect.catchTags({
          SecretRelayError: (error) =>
            error.reason === "no_device"
              ? Effect.succeed<DeviceAnswer>({ type: "no_device" })
              : Effect.fail(
                  refused("The user did not answer on their device before the call ended."),
                ),
        }),
      );
  });

  const fromDevice = (answer: SecretRelay.SecretRelayValues) =>
    found(answer.item, catalog.relay!.values(relayedValues(answer.values)));

  // 1. An item named explicitly, from its own provider or device only.
  const named = request.item;
  if (named?.startsWith(SECRET_RELAY_DEVICE_PREFIX)) {
    if (escalation === "refuse") return yield* refusal();
    const answer = yield* askDevice({ item: named });
    if (answer.type === "values") return yield* fromDevice(answer);
    if (answer.type === "denied") return yield* denied(request.kind, " on their device");
    return yield* unreadable(named, answer.type === "unavailable" ? answer.message : undefined);
  }
  if (named !== undefined) {
    const provider = providers.find((candidate) => named.startsWith(`${candidate.id}/`));
    if (provider === undefined) return yield* unreadable(named);
    if (!provider.unattended) {
      if (escalation === "refuse") return yield* refusal();
      if (!desktopChannel.available) {
        return yield* unreadable(
          named,
          `${provider.account} needs the user's approval in the T3 Code desktop app on this machine.`,
        );
      }
      yield* approve(provider.account);
    }
    const items = yield* catalog
      .find({ provider: provider.id })
      .pipe(Effect.catchIf(sourceFailed, () => Effect.succeed<ReadonlyArray<Item>>([])));
    const item = items.find((candidate) => candidate.id === named);
    if (item === undefined) return yield* unreadable(named);
    return yield* read(item).pipe(Effect.catchIf(sourceFailed, () => unreadable(named)));
  }

  // 2. This machine's service accounts; one that cannot answer now passes the request on.
  if (providers.some((provider) => provider.unattended)) {
    const outcome = yield* take("unattended").pipe(
      Effect.catchIf(sourceFailed, () => Effect.undefined),
    );
    if (outcome !== undefined) return outcome;
  }
  // 3.
  if (escalation === "refuse") return yield* refusal();
  // A person-backed source that answered "none", and the last one that could not answer.
  let none = false;
  let failure: string | undefined;
  // 4. Asked first, then listed, looked up and read.
  const attended = providers.filter((provider) => !provider.unattended);
  if (attended.length > 0 && desktopChannel.available) {
    yield* approve(catalog.prompt?.providerLabel ?? attended.map((p) => p.account).join(", "));
    const outcome = yield* take("attended").pipe(
      Effect.catchIf(sourceFailed, (error) =>
        Effect.sync(() => {
          failure = error.message;
          return undefined;
        }),
      ),
    );
    if (outcome !== undefined) return outcome;
    none = failure === undefined;
  }
  // 5.
  const answer = yield* askDevice(
    request.reference === undefined ? {} : { reference: request.reference },
  );
  switch (answer.type) {
    case "values":
      return yield* fromDevice(answer);
    case "choose":
      return { status: "choose", candidates: answer.candidates };
    case "denied":
      return yield* denied(request.kind, " on their device");
    case "none":
      none = true;
      break;
    case "unavailable":
      failure = `The user's device could not answer: ${answer.message}`;
      break;
  }
  // 6.
  if (lacking !== undefined) return yield* refusal();
  if (none) return { status: "none" };
  return yield* failure === undefined ? refusal() : refused(failure);
});
