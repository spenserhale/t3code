/**
 * Answers secret requests relayed from the user's other machines with this device's own password
 * managers, after asking the user in the desktop app. Only a server with its desktop app attached
 * answers; the values go back once, for one fill, read or command there.
 */
import {
  type PreviewLoginField,
  SECRET_RELAY_DEVICE_PREFIX,
  type SecretRelayAnswer,
  type SecretRelayResolveInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as BrowserLogins from "./BrowserLogins.ts";
import * as BrowserLoginChoice from "./BrowserLoginChoice.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

export class SecretRelayDevice extends Context.Service<
  SecretRelayDevice,
  {
    /** Never fails: a refusal is an `unavailable` answer the requesting server passes on. */
    readonly resolve: (input: SecretRelayResolveInput) => Effect.Effect<SecretRelayAnswer>;
  }
>()("t3/preview/SecretRelayDevice") {}

const unavailable = (message: string): SecretRelayAnswer => ({ type: "unavailable", message });

const deviceId = (id: string) => `${SECRET_RELAY_DEVICE_PREFIX}${id}`;
const ownId = (id: string) =>
  id.startsWith(SECRET_RELAY_DEVICE_PREFIX) ? id.slice(SECRET_RELAY_DEVICE_PREFIX.length) : id;

const summary = (item: BrowserLogins.BrowserIdentityCandidate) => ({
  id: deviceId(item.id),
  title: item.title,
  ...(item.vault ? { vault: item.vault } : {}),
  account: item.account,
});

const redacted = (values: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, Redacted.make(value)] as const],
    ),
  );

const DEFAULT_FIELDS: ReadonlyArray<PreviewLoginField> = ["username", "password"];
const SELECTION_TTL_MS = 5 * 60_000;
const MAX_SELECTIONS = 256;

const make = Effect.gen(function* () {
  const logins = yield* BrowserLogins.BrowserLogins;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const selected = new Map<
    string,
    {
      readonly id: string;
      readonly revision: string;
      readonly fillOrigin?: string;
      readonly siteUrl: string | undefined;
      readonly expiresAt: number;
    }
  >();

  const resolve: SecretRelayDevice["Service"]["resolve"] = Effect.fn("SecretRelayDevice.resolve")(
    function* ({ request, requester }) {
      yield* Effect.annotateCurrentSpan({ "secret_relay.kind": request.kind });
      if (!desktopChannel.available) {
        return unavailable("No SECode desktop app is attached to that device's server to ask.");
      }
      const remaining = Effect.map(Clock.currentTimeMillis, (now) => request.expiresAt - now);
      if ((yield* remaining) <= 0) return unavailable("The request ended before it was shown.");
      const origin = request.origin;
      if (
        (request.kind === "login" || request.kind === "loginChoice") &&
        (origin === undefined || !URL.canParse(origin) || new URL(origin).origin !== origin)
      ) {
        return unavailable("The request did not name the site.");
      }
      if (request.kind === "loginChoice") {
        if (
          request.candidates === undefined ||
          request.candidates.length === 0 ||
          desktopChannel.chooseLogin === undefined
        ) {
          return unavailable("The device needs an updated desktop app that can choose a login.");
        }
        const choice = yield* BrowserLoginChoice.choose(
          { desktopChannel },
          {
            threadId: request.threadId,
            origin: origin!,
            deadline: request.expiresAt,
            candidates: request.candidates,
            machine: requester.label,
            ...(request.threadTitle ? { threadTitle: request.threadTitle } : {}),
            ...(request.agent ? { agent: request.agent } : {}),
          },
        ).pipe(Effect.result);
        if (choice._tag === "Failure")
          return { type: "denied", message: choice.failure.message } as const;
        const id = choice.success;
        const item = request.candidates.find((candidate) => candidate.id === id)!;
        return {
          type: "values",
          item: {
            id,
            title: item.title,
            ...(item.vault ? { vault: item.vault } : {}),
            ...(item.account ? { account: item.account } : {}),
            urls: [],
          },
          values: {},
        } as const;
      }
      const { revision, escalation, providers: chosen } = yield* logins.escalation;
      if (chosen.length === 0) {
        return unavailable("No password manager is chosen for browser logins on that device.");
      }
      // This device's own setting holds for another machine's request: set to refuse, it uses its
      // service accounts alone, and with none it asks nobody.
      const providers =
        escalation === "refuse" ? chosen.filter(({ unattended }) => unattended) : chosen;
      if (providers.length === 0) {
        return unavailable(
          "That device is set to use only its service accounts, and none is chosen for browser logins there.",
        );
      }
      const item =
        request.kind === "login" || request.item === undefined ? undefined : ownId(request.item);
      // An item this device offered earlier is read from its own password manager only.
      const provider =
        item === undefined ? undefined : providers.find(({ id }) => item.startsWith(`${id}/`));
      if (item !== undefined && provider === undefined) {
        return unavailable("That item could not be read; choose again.");
      }
      const reach: BrowserLogins.BrowserLoginReach =
        provider !== undefined
          ? { provider: provider.id }
          : escalation === "refuse"
            ? "unattended"
            : "all";
      const reference = item === undefined ? request.reference : undefined;
      const kind: BrowserLogins.BrowserApprovalKind =
        request.kind !== "identity"
          ? request.kind
          : request.purpose === "read"
            ? "identityRead"
            : "identity";
      const secret = request.kind === "secretReference" ? reference : undefined;
      const fields = [...new Set(request.fields ?? DEFAULT_FIELDS)];
      const selectionKey =
        request.kind === "login"
          ? `${requester.environmentId}\u0000${request.threadId}\u0000${request.tabId ?? ""}\u0000${origin}`
          : undefined;
      const now = yield* Clock.currentTimeMillis;
      for (const [key, selection] of selected) {
        if (selection.expiresAt <= now) selected.delete(key);
      }
      const previous = selectionKey === undefined ? undefined : selected.get(selectionKey);
      const continuing =
        request.kind === "login" &&
        reference === undefined &&
        previous?.revision === revision &&
        previous.siteUrl === request.siteUrl &&
        fields.length > 0 &&
        fields.every((field) => field === "password" || field === "totp") &&
        request.item === deviceId(previous.id);
      const continuedConsent = continuing && (request.tabId?.trim().length ?? 0) > 0;
      // A failed or cancelled new flow must not leave an earlier consent receipt behind.
      if (selectionKey !== undefined) selected.delete(selectionKey);
      if (request.kind === "secretReference") {
        if (secret === undefined) return unavailable("The request did not name a secret.");
        // Which password managers take a reference is known without opening any.
        if ((yield* logins.secretSources(secret, reach)).accounts.length === 0) {
          return { type: "none" } as const;
        }
      }

      // Asked before any password manager is touched: listing and looking up are reads too.
      const scope = { threadId: request.threadId, requester: requester.environmentId };
      if (!continuedConsent && (yield* logins.needsApproval(revision, scope, kind))) {
        const answer = yield* desktopChannel.approveLogin(
          { threadId: request.threadId },
          Math.max(0, yield* remaining),
          {
            kind,
            providerLabel: provider?.account ?? providers.map(({ account }) => account).join(", "),
            ...(reference ? { reference } : {}),
            ...(request.command ? { command: request.command } : {}),
            ...(origin ? { origin } : {}),
            machine: requester.label,
            ...(request.threadTitle ? { threadTitle: request.threadTitle } : {}),
            ...(request.agent ? { agent: request.agent } : {}),
          },
        );
        if (answer === false || (yield* remaining) <= 0) return { type: "denied" } as const;
        if (answer === "thread") yield* logins.recordApproval(revision, scope, kind);
      }

      if (secret !== undefined) {
        const { value, account } = yield* logins.readSecret(revision, secret, reach);
        return {
          type: "values",
          item: { id: secret, title: secret, account, urls: [] },
          values: { value },
        } as const;
      }

      if (request.kind === "login") {
        const page = origin ?? "";
        const found =
          reference === undefined
            ? (yield* logins.candidates(page, reach, request.siteUrl)).logins
            : [(yield* logins.lookupLogin(reference, reach)).login].flatMap((login) =>
                login === undefined ? [] : [login],
              );
        const remembered = continuing ? found.find((login) => login.id === previous.id) : undefined;
        const reused =
          remembered !== undefined &&
          (BrowserLogins.loginCoversPage(remembered.urls, page) || previous?.fillOrigin === page)
            ? remembered
            : undefined;
        if (continuedConsent && reused === undefined)
          return {
            type: "denied",
            message: "The selected login is no longer available for this site. Choose again.",
          } as const;
        const selecting =
          reused === undefined
            ? BrowserLoginChoice.select(
                { logins, desktopChannel },
                {
                  revision,
                  candidates: found,
                  threadId: request.threadId,
                  origin: page,
                  deadline: request.expiresAt,
                  forceChoice: request.item !== undefined,
                  machine: requester.label,
                  ...(request.threadTitle ? { threadTitle: request.threadTitle } : {}),
                  ...(request.agent ? { agent: request.agent } : {}),
                },
              )
            : Effect.succeed({
                ...reused,
                userChosen: true,
                ...(previous?.fillOrigin === undefined ? {} : { fillOrigin: previous.fillOrigin }),
              });
        const selection = yield* selecting.pipe(Effect.result);
        if (selection._tag === "Failure")
          return { type: "denied", message: selection.failure.message } as const;
        const login = selection.success;
        if (login === undefined) return { type: "none" } as const;
        if ((yield* remaining) <= 0) return { type: "denied" } as const;
        const read = yield* logins.check(revision).pipe(
          Effect.andThen(logins.read(revision, login, fields)),
          Effect.tap(() => logins.check(revision)),
          Effect.result,
        );
        if (read._tag === "Failure") {
          if (login.userChosen || read.failure.reason === "changed")
            return {
              type: "denied",
              message:
                read.failure.reason === "changed"
                  ? "The browser login settings changed. Try again."
                  : `The selected login "${login.title}" could not be read. Unlock its password manager or choose another login, then try again.`,
            } as const;
          return yield* read.failure;
        }
        const values = read.success;
        const absent = fields.filter((field) => values[field] === undefined);
        if (login.userChosen && absent.length > 0)
          return {
            type: "denied",
            message: `The selected login "${login.title}" has no ${absent.join(" or ")}. Choose another login or ask the user to sign in.`,
          } as const;
        // Another device may hold what this login lacks, so only a named one goes back short.
        if (reused === undefined && fields.some((field) => values[field] === undefined)) {
          return { type: "none" } as const;
        }
        if ((yield* remaining) <= 0) return { type: "denied" } as const;
        if (selected.size >= MAX_SELECTIONS) selected.delete(selected.keys().next().value!);
        selected.set(selectionKey!, {
          id: login.id,
          revision,
          siteUrl: request.siteUrl,
          expiresAt:
            reused === undefined
              ? (yield* Clock.currentTimeMillis) + SELECTION_TTL_MS
              : previous!.expiresAt,
          ...(login.fillOrigin === undefined ? {} : { fillOrigin: login.fillOrigin }),
        });
        return {
          type: "values",
          item: {
            ...summary(login),
            urls: login.urls,
            ...(login.fillOrigin === undefined ? {} : { fillOrigin: login.fillOrigin }),
            ...(values.hasTotp === undefined ? {} : { hasTotp: values.hasTotp }),
          },
          values: redacted(Object.fromEntries(fields.map((field) => [field, values[field]]))),
        } as const;
      }

      const found =
        reference === undefined
          ? (yield* logins.identityCandidates(reach)).identities
          : [(yield* logins.lookupIdentity(reference, reach)).identity].flatMap((identity) =>
              identity === undefined ? [] : [identity],
            );
      const matching = found.filter((identity) => item === undefined || identity.id === item);
      const [identity, ...others] = matching;
      if (identity === undefined) return { type: "none" } as const;
      if (others.length > 0) {
        return { type: "choose", candidates: matching.map(summary) } as const;
      }
      const values = yield* logins.readIdentity(revision, identity);
      return {
        type: "values",
        item: { ...summary(identity), urls: [] },
        values: redacted(values),
      } as const;
    },
    Effect.catchTags({
      BrowserLoginError: (error) => Effect.succeed(unavailable(error.message)),
    }),
  );

  return SecretRelayDevice.of({ resolve });
});

export const layer = Layer.effect(SecretRelayDevice, make);
