import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewLoginCandidate, PreviewLoginField } from "./previewLogin.ts";

/**
 * Relaying a secret request from a server nobody can approve on, such as a remote machine, to the
 * user's device. A client subscribes on the requesting server, has its own desktop server ask the
 * user and read the item there, and answers. Values cross the wire only inside a `values` answer,
 * redacted on both ends.
 */

export const SecretRelayKind = Schema.Literals(["login", "identity"]);
export type SecretRelayKind = typeof SecretRelayKind.Type;

export const SecretRelayRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  kind: SecretRelayKind,
  threadId: TrimmedNonEmptyString,
  threadTitle: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  /** The page's origin. A login is offered only for the site it is saved for. */
  origin: Schema.optional(Schema.String),
  /** A `device:` id from an earlier `choose` answer. */
  item: Schema.optional(TrimmedNonEmptyString),
  /** An item the user named, such as `op://Vault/Item`. */
  reference: Schema.optional(TrimmedNonEmptyString),
  /** The login fields to read; default username and password. */
  fields: Schema.optional(Schema.Array(PreviewLoginField)),
  /** For an identity: fill a page, or show the values to the agent. */
  purpose: Schema.optional(Schema.Literals(["fill", "read"])),
  /** Epoch milliseconds when the requesting call ends. */
  expiresAt: Schema.Number,
});
export type SecretRelayRequest = typeof SecretRelayRequest.Type;

export const SecretRelayStreamItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal("request"), request: SecretRelayRequest }),
  /** Answered, timed out, or its call ended: stop asking about it. */
  Schema.Struct({ type: Schema.Literal("ended"), requestId: TrimmedNonEmptyString }),
]);
export type SecretRelayStreamItem = typeof SecretRelayStreamItem.Type;

export const SecretRelaySubscribeInput = Schema.Struct({
  /** The kinds this client can answer. Unknown ones are ignored, so a newer client can name more. */
  kinds: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(16)),
});
export type SecretRelaySubscribeInput = typeof SecretRelaySubscribeInput.Type;

export const SecretRelayItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  vault: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  /** Websites a login fills on; empty for an identity. */
  urls: Schema.Array(Schema.String),
});
export type SecretRelayItem = typeof SecretRelayItem.Type;

export const SecretRelayAnswer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("values"),
    item: SecretRelayItem,
    values: Schema.Record(Schema.String, Schema.RedactedFromValue(Schema.String)),
  }),
  /** Ids are `device:` ids, for the agent to pass back. */
  Schema.Struct({
    type: Schema.Literal("choose"),
    candidates: Schema.Array(PreviewLoginCandidate),
  }),
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("denied") }),
  Schema.Struct({ type: Schema.Literal("unavailable"), message: Schema.String }),
]);
export type SecretRelayAnswer = typeof SecretRelayAnswer.Type;

export const SecretRelayAnswerInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  answer: SecretRelayAnswer,
});
export type SecretRelayAnswerInput = typeof SecretRelayAnswerInput.Type;

export const SecretRelayResolveInput = Schema.Struct({
  request: SecretRelayRequest,
  /** The environment the request came from, named in the dialog. */
  requester: Schema.Struct({
    environmentId: EnvironmentId,
    label: Schema.String.check(Schema.isMaxLength(200)),
  }),
});
export type SecretRelayResolveInput = typeof SecretRelayResolveInput.Type;

/** Candidate ids a device hands out; an id with it routes back to the device. */
export const SECRET_RELAY_DEVICE_PREFIX = "device:";
