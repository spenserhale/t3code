/**
 * Answers secret requests relayed from the user's other machines with this device's own password
 * managers, after asking the user in the desktop app. Only a server with its desktop app attached
 * answers; the values go back once, for one fill or read there.
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

const make = Effect.gen(function* () {
  const logins = yield* BrowserLogins.BrowserLogins;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;

  const resolve: SecretRelayDevice["Service"]["resolve"] = Effect.fn("SecretRelayDevice.resolve")(
    function* ({ request, requester }) {
      yield* Effect.annotateCurrentSpan({ "secret_relay.kind": request.kind });
      if (!desktopChannel.available) {
        return unavailable("No T3 Code desktop app is attached to that device's server to ask.");
      }
      const remaining = Effect.map(Clock.currentTimeMillis, (now) => request.expiresAt - now);
      if ((yield* remaining) <= 0) return unavailable("The request ended before it was shown.");
      const origin = request.origin;
      if (request.kind === "login" && origin === undefined) {
        return unavailable("The request did not name the site.");
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
          "That device is set not to ask its user, and no service account is chosen for browser logins there.",
        );
      }
      const item = request.item === undefined ? undefined : ownId(request.item);
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
        request.kind === "login"
          ? "login"
          : request.purpose === "read"
            ? "identityRead"
            : "identity";

      // Asked before any password manager is touched: listing and looking up are reads too.
      const scope = { threadId: request.threadId, requester: requester.environmentId };
      if (yield* logins.needsApproval(revision, scope, kind)) {
        const answer = yield* desktopChannel.approveLogin(
          { threadId: request.threadId },
          Math.max(0, yield* remaining),
          {
            kind,
            providerLabel: provider?.account ?? providers.map(({ account }) => account).join(", "),
            ...(reference ? { reference } : {}),
            ...(origin ? { origin } : {}),
            machine: requester.label,
            ...(request.threadTitle ? { threadTitle: request.threadTitle } : {}),
            ...(request.agent ? { agent: request.agent } : {}),
          },
        );
        if (answer === false || (yield* remaining) <= 0) return { type: "denied" } as const;
        if (answer === "thread") yield* logins.recordApproval(revision, scope, kind);
      }

      if (request.kind === "login") {
        const page = origin ?? "";
        const found =
          reference === undefined
            ? (yield* logins.candidates(page, reach)).logins
            : [(yield* logins.lookupLogin(reference, reach)).login].flatMap((login) =>
                login === undefined ? [] : [login],
              );
        const matching = found.filter((login) => item === undefined || login.id === item);
        const [login, ...others] = matching;
        if (login === undefined) return { type: "none" } as const;
        if (others.length > 0) {
          return { type: "choose", candidates: matching.map(summary) } as const;
        }
        if (!BrowserLogins.loginCoversPage(login.urls, page)) {
          return unavailable(`The login "${login.title}" is saved for another site.`);
        }
        const fields = [...new Set(request.fields ?? DEFAULT_FIELDS)];
        const values = yield* logins.read(revision, login, fields);
        // Another device may hold what this login lacks, so only a named one goes back short.
        if (item === undefined && fields.some((field) => values[field] === undefined)) {
          return { type: "none" } as const;
        }
        return {
          type: "values",
          item: { ...summary(login), urls: login.urls },
          values: redacted(values),
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
