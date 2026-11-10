/**
 * The order every secret request follows: this machine's unattended providers (a service account
 * is the user's approval), then a person, in this machine's desktop app or on the user's device
 * through the relay, else a refusal the agent can pass on.
 */
import type { BrowserSecretEscalation, SecretRelayAnswer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import type * as SecretRelay from "../secrets/SecretRelay.ts";
import type * as BrowserLogins from "./BrowserLogins.ts";
import type * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import { loginError } from "./ServerBrowserLogin.ts";

export interface SecretAccessContext {
  readonly logins: Pick<BrowserLogins.BrowserLogins["Service"], "needsApproval" | "recordApproval">;
  readonly desktopChannel: Pick<
    DesktopBrowserChannel.DesktopBrowserChannel["Service"],
    "available" | "approveLogin"
  >;
  readonly relay: SecretRelay.SecretRelay["Service"] | undefined;
  /** Runs a step of the login service; its failure becomes an operation error. */
  readonly step: <A>(effect: Effect.Effect<A, BrowserLogins.BrowserLoginError>) => Promise<A>;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
}

/**
 * A step on unattended providers. One that cannot list now, such as a rate-limited service
 * account, leaves the request to a person instead of failing it; the listing logged why.
 */
export const tryUnattended = <A>(
  context: Pick<SecretAccessContext, "step">,
  effect: Effect.Effect<A, BrowserLogins.BrowserLoginError>,
): Promise<A | undefined> =>
  context
    .step(
      effect.pipe(
        Effect.asSome,
        Effect.catchTags({
          BrowserLoginError: (error) =>
            error.reason === "unreadable" ? Effect.succeedNone : Effect.fail(error),
        }),
      ),
    )
    .then(Option.getOrUndefined);

/**
 * Asks in this machine's desktop dialog unless the user allowed this kind for the thread. Throws
 * on Deny, and on an answer that came after the call ended.
 */
export const approveHere = async (
  context: Omit<SecretAccessContext, "relay">,
  input: {
    readonly revision: string;
    readonly kind: BrowserLogins.BrowserApprovalKind;
    readonly key: DesktopBrowserChannel.DesktopApprovalKey;
    readonly prompt: Omit<DesktopBrowserChannel.DesktopLoginPrompt, "kind">;
    readonly deadlineMs: number;
    readonly denied: string;
  },
) => {
  const scope = { threadId: input.key.threadId };
  if (!(await context.step(context.logins.needsApproval(input.revision, scope, input.kind)))) {
    return;
  }
  const answer = await context.runPromise(
    context.desktopChannel.approveLogin(
      input.key,
      Math.max(0, input.deadlineMs - performance.now()),
      { kind: input.kind, ...input.prompt },
    ),
  );
  if (answer === false) throw loginError(input.denied);
  if (performance.now() >= input.deadlineMs) {
    throw loginError("The approval came after the call ended.");
  }
  if (answer === "thread") {
    await context.step(context.logins.recordApproval(input.revision, scope, input.kind));
  }
};

/** Why nobody could answer, in words an agent can pass on to the user. */
const refusal = (what: string, escalation: BrowserSecretEscalation) =>
  loginError(
    `No service account on this machine can open ${what}, and ${
      escalation === "refuse"
        ? "this machine is set not to ask the user's device"
        : "no T3 Code desktop app that can ask the user is connected"
    }. It needs Touch ID on a connected Mac, or a service account on this machine with access to that item.`,
  );

/**
 * Sends the request to the user's device and waits for its answer within the call. Refuses when
 * this machine is set to refuse, no device is connected, or the user or device says no.
 */
export const relay = async (
  context: SecretAccessContext,
  input: {
    readonly escalation: BrowserSecretEscalation;
    readonly ask: SecretRelay.SecretRelayAsk;
    readonly deadlineMs: number;
    /** What was asked for, such as "a login for https://example.com". */
    readonly what: string;
    readonly denied: string;
  },
): Promise<Exclude<SecretRelayAnswer, { readonly type: "denied" | "unavailable" }>> => {
  const { relay: secretRelay } = context;
  if (input.escalation === "refuse" || secretRelay === undefined) {
    throw refusal(input.what, input.escalation);
  }
  const outcome = await context.runPromise(
    secretRelay.request(input.ask, Math.max(0, input.deadlineMs - performance.now())).pipe(
      Effect.map((answer) => ({ answer })),
      Effect.catchTags({ SecretRelayError: (error) => Effect.succeed({ error }) }),
    ),
  );
  if ("error" in outcome) {
    throw outcome.error.reason === "no_device"
      ? refusal(input.what, input.escalation)
      : loginError("The user did not answer on their device before the call ended.");
  }
  const { answer } = outcome;
  if (answer.type === "denied") throw loginError(input.denied);
  if (answer.type === "unavailable") {
    throw loginError(`The user's device could not answer: ${answer.message}`);
  }
  return answer;
};

/** A relayed answer's values, unwrapped only where they are filled or handed over. */
export const relayedValues = (
  values: Readonly<Record<string, Redacted.Redacted<string>>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Redacted.value(value)]));
