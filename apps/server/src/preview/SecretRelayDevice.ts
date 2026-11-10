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
      const scope = { threadId: request.threadId, requester: requester.environmentId };
      const item = request.item === undefined ? undefined : ownId(request.item);
      const reference = item === undefined ? request.reference : undefined;

      /** The dialog, unless this thread on that machine was allowed this kind already. */
      const approve = Effect.fn("SecretRelayDevice.approve")(function* (
        revision: string,
        kind: BrowserLogins.BrowserApprovalKind,
        prompt: Omit<DesktopBrowserChannel.DesktopLoginPrompt, "kind" | "machine">,
      ) {
        if (!(yield* logins.needsApproval(revision, scope, kind))) return true;
        const answer = yield* desktopChannel.approveLogin(
          { threadId: request.threadId },
          Math.max(0, yield* remaining),
          {
            kind,
            ...prompt,
            machine: requester.label,
            ...(request.threadTitle ? { threadTitle: request.threadTitle } : {}),
            ...(request.agent ? { agent: request.agent } : {}),
          },
        );
        if (answer === "thread") yield* logins.recordApproval(revision, scope, kind);
        return answer !== false && (yield* remaining) > 0;
      });

      if (request.kind === "login") {
        const origin = request.origin;
        if (origin === undefined) return unavailable("The request did not name the site.");
        const { revision, found } =
          reference === undefined
            ? yield* logins.candidates(origin, "all").pipe(
                Effect.map(({ revision, logins: covering }) => ({
                  revision,
                  found: covering.filter((login) => item === undefined || login.id === item),
                })),
              )
            : yield* logins.lookupLogin(reference, "all").pipe(
                Effect.map(({ revision, login }) => ({
                  revision,
                  found: login === undefined ? [] : [login],
                })),
              );
        const [login, ...others] = found;
        if (login === undefined) return { type: "none" } as const;
        if (others.length > 0) return { type: "choose", candidates: found.map(summary) } as const;
        if (!BrowserLogins.loginCoversPage(login.urls, origin)) {
          return unavailable(`The login "${login.title}" is saved for another site.`);
        }
        const allowed = yield* approve(revision, "login", {
          providerLabel: login.account,
          loginTitle: login.title,
          ...(login.vault ? { vault: login.vault } : {}),
          origin,
        });
        if (!allowed) return { type: "denied" } as const;
        const values = yield* logins.read(revision, login, [
          ...new Set(request.fields ?? DEFAULT_FIELDS),
        ]);
        return {
          type: "values",
          item: { ...summary(login), urls: login.urls },
          values: redacted(values),
        } as const;
      }

      const { revision, found } =
        reference === undefined
          ? yield* logins.identityCandidates("all").pipe(
              Effect.map(({ revision, identities }) => ({
                revision,
                found: identities.filter((identity) => item === undefined || identity.id === item),
              })),
            )
          : yield* logins.lookupIdentity(reference, "all").pipe(
              Effect.map(({ revision, identity }) => ({
                revision,
                found: identity === undefined ? [] : [identity],
              })),
            );
      const [identity, ...others] = found;
      if (identity === undefined) return { type: "none" } as const;
      if (others.length > 0) return { type: "choose", candidates: found.map(summary) } as const;
      const allowed = yield* approve(
        revision,
        request.purpose === "read" ? "identityRead" : "identity",
        {
          providerLabel: identity.account,
          loginTitle: identity.title,
          ...(identity.vault ? { vault: identity.vault } : {}),
          ...(request.origin ? { origin: request.origin } : {}),
        },
      );
      if (!allowed) return { type: "denied" } as const;
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
