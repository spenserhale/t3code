import * as Schema from "effect/Schema";

/**
 * Running an agent's command with secrets from the user's password manager, passed on its stdin or
 * in its environment. The agent names references; the values never reach it, and the command's
 * output comes back with them masked.
 */

export const SECRET_COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
const SECRET_COMMAND_MAX_TIMEOUT_MS = 600_000;
const SECRET_COMMAND_MAX_ENV = 8;

const SecretCommandReference = Schema.String.check(
  Schema.isMaxLength(1_024),
  Schema.isStartingWith("op://", {
    message: "Use a 1Password reference like op://Vault/Item/field.",
  }),
);

const SecretCommandEnvName = Schema.String.check(
  Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/u, {
    message: "Environment variable names are upper case letters, digits and underscores.",
  }),
);

export const SecretCommandInput = Schema.Struct({
  command: Schema.Array(Schema.String.check(Schema.isMaxLength(4_096)))
    .check(Schema.isMinLength(1), Schema.isMaxLength(64))
    .annotate({ description: "argv. No shell unless you pass one." }),
  stdin: Schema.optional(SecretCommandReference).annotate({
    description: "Its value and a newline become stdin.",
  }),
  // Names are checked rather than typed as the key, which would drop a bad one silently.
  env: Schema.optional(
    Schema.Record(Schema.String, SecretCommandReference).check(
      Schema.isPropertyNames(SecretCommandEnvName),
      Schema.isMaxProperties(SECRET_COMMAND_MAX_ENV),
    ),
  ).annotate({ description: "Variable name to reference." }),
  cwd: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))).annotate({
    description: "Relative to the thread's workspace.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SECRET_COMMAND_MAX_TIMEOUT_MS })),
  ).annotate({ description: "Default 60000." }),
}).check(
  Schema.makeFilter((input) =>
    input.stdin !== undefined || Object.keys(input.env ?? {}).length > 0
      ? true
      : "Pass a secret in `stdin`, `env`, or both.",
  ),
);
export type SecretCommandInput = typeof SecretCommandInput.Type;

/** Who supplied a secret: a service account on this machine, or the user on their device. */
export const SecretCommandSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("serviceAccount"),
    /** Its name in Settings > Secrets. */
    label: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("device") }),
]);
export type SecretCommandSource = typeof SecretCommandSource.Type;

export const SecretCommandResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int).annotate({ description: "null when a signal ended it." }),
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean.annotate({ description: "stdout or stderr was cut at about 64 KB." }),
  sources: Schema.Struct({
    stdin: Schema.optional(SecretCommandSource),
    env: Schema.optional(Schema.Record(Schema.String, SecretCommandSource)),
  }),
});
export type SecretCommandResult = typeof SecretCommandResult.Type;
