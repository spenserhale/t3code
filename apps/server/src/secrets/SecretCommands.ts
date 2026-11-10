/**
 * Runs an agent's command with secrets on its stdin or in its environment, so the agent never sees
 * them. Each secret takes the order of `BrowserSecretAccess.ts`: a service account here, then this
 * machine's desktop app or the user's device, else a refusal. Its output comes back masked.
 */
import {
  SECRET_COMMAND_DEFAULT_TIMEOUT_MS,
  type SecretCommandInput,
  type SecretCommandResult,
  type SecretCommandSource,
  type ThreadId,
} from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BrowserLogins from "../preview/BrowserLogins.ts";
import * as BrowserSecretAccess from "../preview/BrowserSecretAccess.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import * as SecretRelay from "./SecretRelay.ts";

export class SecretCommandError extends Schema.TaggedError<SecretCommandError>()(
  "SecretCommandError",
  {
    reason: Schema.Literals(["invalid", "refused", "timeout", "failed"]),
    message: Schema.String,
  },
) {}

/** The calling thread, named in what the user is asked. */
export interface SecretCommandCaller {
  readonly threadId: ThreadId;
  readonly threadTitle?: string | undefined;
  /** The provider instance the agent runs on. */
  readonly agent?: string | undefined;
}

export class SecretCommands extends Context.Service<
  SecretCommands,
  {
    /**
     * Gets every secret the input names, then runs the command in the thread's workspace with
     * the server's environment and the secrets. Nothing the agent gets back holds a secret.
     */
    readonly run: (
      caller: SecretCommandCaller,
      input: SecretCommandInput,
    ) => Effect.Effect<SecretCommandResult, SecretCommandError>;
  }
>()("t3/secrets/SecretCommands") {}

/** Each of stdout and stderr. */
const OUTPUT_LIMIT = 64 * 1024;
/** How long the user has to allow every secret a command uses. */
const APPROVAL_TIMEOUT_MS = 120_000;
const COMMAND_DISPLAY_LIMIT = 200;
const FORCE_KILL_AFTER = Duration.seconds(1);
export const SECRET_MASK = "[secret]";

const utf8 = new TextEncoder();

const maskForms = (secrets: ReadonlyArray<string>) =>
  [...new Set(secrets.flatMap((secret) => [secret, secret.trim()]))]
    .filter((form) => form.length > 0)
    .sort((a, b) => b.length - a.length);

/**
 * `text` with every secret, and every secret's trimmed form, masked in one pass, then cut at
 * `limit`. One that starts before the cut is masked whole, so a cut never leaves part of one.
 */
export const maskSecrets = (text: string, secrets: ReadonlyArray<string>, limit: number) => {
  const forms = maskForms(secrets);
  const next = forms.map((form) => text.indexOf(form));
  let masked = "";
  let at = 0;
  for (;;) {
    let found = -1;
    for (let index = 0; index < forms.length; index++) {
      if (next[index]! !== -1 && next[index]! < at) next[index] = text.indexOf(forms[index]!, at);
      if (next[index]! !== -1 && (found === -1 || next[index]! < next[found]!)) found = index;
    }
    const start = found === -1 ? -1 : next[found]!;
    if (start === -1 || start >= limit) break;
    masked += `${text.slice(at, start)}${SECRET_MASK}`;
    at = start + forms[found]!.length;
  }
  const end = Math.max(at, Math.min(limit, text.length));
  return { text: `${masked}${text.slice(at, end)}`, cut: end < text.length };
};

const displayCommand = (argv: ReadonlyArray<string>) => {
  const shown = CommandLine.display(argv);
  return shown.length > COMMAND_DISPLAY_LIMIT
    ? `${shown.slice(0, COMMAND_DISPLAY_LIMIT - 1)}…`
    : shown;
};

const invalid = (message: string) => new SecretCommandError({ reason: "invalid", message });
const refused = (message: string) => new SecretCommandError({ reason: "refused", message });
const fromLogin = (error: BrowserLogins.BrowserLoginError) => refused(error.message);

// Fixed words only: a spawn failure can quote the command line, and Node's own errors can quote
// an environment value.
const notStarted = (executable: string, error: PlatformError.PlatformError) => {
  const reason = error.reason;
  const message =
    reason._tag !== "NotFound"
      ? reason._tag === "PermissionDenied"
        ? `\`${executable}\` could not be run: permission denied.`
        : `\`${executable}\` could not be started.`
      : reason.module === "FileSystem"
        ? "The working directory does not exist."
        : `\`${executable}\` was not found on this machine.`;
  return new SecretCommandError({ reason: "failed", message });
};

interface Resolved {
  readonly value: Redacted.Redacted<string>;
  readonly source: SecretCommandSource;
}

/** A reference, looked for in the providers of one reach. */
interface ReferenceItem extends BrowserSecretAccess.SecretItem {
  readonly reach: BrowserLogins.BrowserLoginReach;
}

const make = Effect.gen(function* () {
  const logins = yield* BrowserLogins.BrowserLogins;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  // Optional, as for the browser, so a server built without the relay refuses at once.
  const relay = Option.getOrUndefined(yield* Effect.serviceOption(SecretRelay.SecretRelay));
  const access = { logins, desktopChannel, relay };
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;

  const workspaceOf = (threadId: ThreadId) =>
    threadWorkspaceRoot(threadId).pipe(
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      Effect.provideService(ProjectService.ProjectService, projects),
    );

  /** One secret, in the order every secret request follows (see `BrowserSecretAccess`). */
  const resolveSecret = Effect.fn("SecretCommands.resolveSecret")(function* (
    caller: SecretCommandCaller,
    reference: string,
    command: string,
    deadline: number,
  ): Effect.fn.Return<Resolved, SecretCommandError> {
    const requester = {
      ...(caller.threadTitle ? { threadTitle: caller.threadTitle } : {}),
      ...(caller.agent ? { agent: caller.agent } : {}),
    };
    const found = yield* BrowserSecretAccess.resolve(
      access,
      { kind: "secretReference", threadId: caller.threadId, ...requester, reference, deadline },
      {
        what: reference,
        // Which providers take the reference is known without reading it.
        find: (reach) =>
          logins
            .secretSources(reference, reach)
            .pipe(
              Effect.map(({ accounts }): ReadonlyArray<ReferenceItem> =>
                accounts.length === 0 ? [] : [{ id: reference, title: reference, reach }],
              ),
            ),
        read: (revision, item) =>
          logins.readSecret(revision, reference, item.reach).pipe(
            Effect.map((secret): Resolved | undefined => ({
              value: secret.value,
              source:
                item.reach === "unattended"
                  ? { type: "serviceAccount", label: secret.account }
                  : { type: "device" },
            })),
          ),
        relay: {
          ask: { kind: "secretReference", threadId: caller.threadId, ...requester, command },
          values: ({ value }): Resolved | undefined =>
            value === undefined
              ? undefined
              : { value: Redacted.make(value), source: { type: "device" } },
        },
        prompt: { command },
      },
    ).pipe(Effect.mapError(fromLogin));
    if (found.status !== "found") {
      return yield* refused(`No password manager can open ${reference}.`);
    }
    if (found.values === undefined) {
      return yield* refused(`The user's device did not return ${reference}.`);
    }
    return found.values;
  });

  /** Captures at most about `OUTPUT_LIMIT` of a stream, with every secret masked. */
  const collectMasked = (
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    secrets: ReadonlyArray<string>,
  ) => {
    // Enough past the limit to hold a secret that starts before it, so it is masked whole.
    const margin = Math.max(0, ...maskForms(secrets).map((form) => utf8.encode(form).length));
    return collectUint8StreamText({ stream, maxBytes: OUTPUT_LIMIT + margin }).pipe(
      Effect.map((collected) => {
        const limit = collected.truncated
          ? Math.min(OUTPUT_LIMIT, Math.max(0, collected.text.length - margin))
          : OUTPUT_LIMIT;
        const { text, cut } = maskSecrets(collected.text, secrets, limit);
        return { text, truncated: collected.truncated || cut };
      }),
      Effect.mapError(
        () =>
          new SecretCommandError({ reason: "failed", message: "The output could not be read." }),
      ),
    );
  };

  const execute = Effect.fn("SecretCommands.execute")(function* (input: {
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Readonly<Record<string, Redacted.Redacted<string>>>;
    readonly stdin: Redacted.Redacted<string> | undefined;
    readonly secrets: ReadonlyArray<Redacted.Redacted<string>>;
    readonly timeoutMs: number;
  }) {
    const [executable = "", ...args] = input.argv;
    const resolved = yield* resolveSpawnCommand(executable, args);
    const secrets = input.secrets.map(Redacted.value);
    const spawned: { child?: ChildProcessSpawner.ChildProcessHandle } = {};
    // The timer starts before the spawn, so a spawn that hangs is stopped too.
    const finished = yield* Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: input.cwd,
            env: input.env,
            extendEnv: true,
            shell: resolved.shell,
            stdin: input.stdin === undefined ? "ignore" : "pipe",
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        )
        .pipe(Effect.mapError((error) => notStarted(executable, error)));
      spawned.child = handle;
      const stdin = input.stdin;
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectMasked(handle.stdout, secrets),
          collectMasked(handle.stderr, secrets),
          handle.exitCode.pipe(
            Effect.map((code): number | null => code),
            // Ended by a signal.
            Effect.orElseSucceed(() => null),
          ),
          // A command may exit without reading its input; its exit code says how it went.
          stdin === undefined
            ? Effect.void
            : Stream.run(Stream.make(utf8.encode(`${Redacted.value(stdin)}\n`)), handle.stdin).pipe(
                Effect.ignore,
              ),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    }).pipe(Effect.timeoutOption(Duration.millis(input.timeoutMs)));
    if (Option.isNone(finished)) {
      if (spawned.child !== undefined) {
        yield* spawned.child.kill({ forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore);
      }
      return yield* new SecretCommandError({
        reason: "timeout",
        message: `The command did not finish within ${input.timeoutMs} ms, so it was stopped.`,
      });
    }
    return finished.value;
  }, Effect.scoped);

  const run: SecretCommands["Service"]["run"] = Effect.fn("SecretCommands.run")(
    function* (caller, input) {
      const env = Object.entries(input.env ?? {});
      yield* Effect.annotateCurrentSpan({
        "secret_command.stdin": input.stdin !== undefined,
        "secret_command.env": env.length,
      });
      const root = yield* workspaceOf(caller.threadId);
      if (root === undefined)
        return yield* invalid("This thread has no workspace on this machine.");
      const workspaceRoot = path.resolve(root);
      const cwd = path.resolve(workspaceRoot, input.cwd ?? ".");
      if (path.isAbsolute(input.cwd ?? "") || !isWithinRoot(path, cwd, workspaceRoot)) {
        return yield* invalid("`cwd` must be a relative path inside the thread's workspace.");
      }

      const command = displayCommand(input.command);
      const deadline = (yield* Clock.currentTimeMillis) + APPROVAL_TIMEOUT_MS;
      const resolved = new Map<string, Resolved>();
      for (const reference of [input.stdin, ...env.map(([, reference]) => reference)]) {
        if (reference === undefined || resolved.has(reference)) continue;
        resolved.set(reference, yield* resolveSecret(caller, reference, command, deadline));
      }
      const secretFor = (reference: string) => resolved.get(reference)!;
      for (const [name, reference] of env) {
        if (Redacted.value(secretFor(reference).value).includes("\0")) {
          return yield* invalid(
            `The secret for ${name} cannot be passed in an environment variable.`,
          );
        }
      }

      const output = yield* execute({
        argv: input.command,
        cwd,
        env: Object.fromEntries(env.map(([name, reference]) => [name, secretFor(reference).value])),
        stdin: input.stdin === undefined ? undefined : secretFor(input.stdin).value,
        secrets: [...resolved.values()].map((secret) => secret.value),
        timeoutMs: input.timeoutMs ?? SECRET_COMMAND_DEFAULT_TIMEOUT_MS,
      });
      return {
        exitCode: output.exitCode,
        stdout: output.stdout.text,
        stderr: output.stderr.text,
        truncated: output.stdout.truncated || output.stderr.truncated,
        sources: {
          ...(input.stdin === undefined ? {} : { stdin: secretFor(input.stdin).source }),
          ...(env.length === 0
            ? {}
            : {
                env: Object.fromEntries(
                  env.map(([name, reference]) => [name, secretFor(reference).source]),
                ),
              }),
        },
      };
    },
  );

  return SecretCommands.of({ run });
});

export const layer = Layer.effect(SecretCommands, make);
