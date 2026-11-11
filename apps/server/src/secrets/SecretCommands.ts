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
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
const MASK_BYTES = utf8.encode(SECRET_MASK);
/** Reads UTF-8 as `Buffer.toString` does: a byte order mark stays in the text. */
const utf8Decoder = () => new TextDecoder("utf-8", { ignoreBOM: true });

/** Shorter, a mask would hide ordinary words and numbers too, so such a secret is refused. */
const MIN_SECRET_LENGTH = 4;

/** Each secret whole and trimmed, and each of its lines long enough to mask on its own. */
const maskForms = (secrets: ReadonlyArray<string>) =>
  [
    ...new Set(
      secrets.flatMap((secret) => [
        secret,
        secret.trim(),
        ...secret
          .split(/\r\n|\r|\n/)
          .map((line) => line.trim())
          .filter((line) => line.length >= MIN_SECRET_LENGTH),
      ]),
    ),
  ].filter((form) => form.length > 0);

/**
 * Where `text` holds any of `forms`, as `[start, end)` runs in order. Every match counts,
 * overlapping ones included, and matches that overlap or touch make one run. A run that began
 * before `text` and reaches `covered` characters into it counts as a match of that length.
 */
const secretRuns = (text: string, forms: ReadonlyArray<string>, covered: number) => {
  // +1 where a match starts and -1 where it ends: a run is where the sum stays above zero.
  const edges = new Int32Array(text.length + 1);
  edges[0]! += 1;
  edges[covered]! -= 1;
  for (const form of forms) {
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
      edges[at]! += 1;
      edges[at + form.length]! -= 1;
    }
  }
  const runs: Array<readonly [start: number, end: number]> = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    const before = depth;
    depth += edges[index]!;
    if (before === 0 && depth > 0) start = index;
    if (before > 0 && depth === 0) runs.push([start, index]);
  }
  return runs;
};

/**
 * Masks a command's output as it arrives: each run of secrets becomes one mask, wherever chunks
 * divide it. Keeps at most `maxBytes` of the masked text in UTF-8, cut between characters, with a
 * mask that does not fit left out whole. What is written after that is dropped unread.
 */
export const makeOutputMasker = (secrets: ReadonlyArray<string>, maxBytes: number) => {
  const forms = maskForms(secrets);
  // A match can start in this many of the last characters and end in output still to come.
  const hold = Math.max(1, ...forms.map((form) => form.length)) - 1;
  const decoder = utf8Decoder();
  // Bytes, not text: a piece of text cut from a chunk would keep that whole chunk in memory.
  const shown = new Uint8Array(maxBytes);
  let used = 0;
  let cut = false;
  /** Read, and not shown yet. */
  let pending = "";
  /** How far into `pending` a run that already has its mask reaches, or -1 when none does. */
  let masked = -1;

  /** Shows `piece`, or as much of it as fits and never part of a character. */
  const addText = (piece: string) => {
    const { read, written } = utf8.encodeInto(piece, shown.subarray(used));
    used += written;
    return read === piece.length;
  };
  /** Shows a mask whole, or nothing. */
  const addMask = () => {
    if (MASK_BYTES.length > maxBytes - used) return false;
    shown.set(MASK_BYTES, used);
    used += MASK_BYTES.length;
    return true;
  };

  /** Shows what of `pending` starts before `end`, each run as one mask: whether it all fit. */
  const show = (end: number) => {
    let at = 0;
    for (const [start, stop] of secretRuns(pending, forms, Math.max(0, masked))) {
      if (start >= end) break;
      // A run that goes on from one already masked gets no second mask.
      const goesOn = start === 0 && masked >= 0;
      if (!addText(pending.slice(at, start)) || !(goesOn || addMask())) return false;
      at = stop;
    }
    if (!addText(pending.slice(at, end))) return false;
    masked = at < end ? -1 : at - end;
    pending = pending.slice(end);
    return true;
  };
  /** Shows up to `end`. Once something does not fit, nothing after it is shown or kept. */
  const advance = (end: number) => {
    cut = !show(end);
    if (cut) pending = "";
  };

  return {
    /** The next bytes of the output. */
    write: (chunk: Uint8Array) => {
      if (cut) return;
      pending += decoder.decode(chunk, { stream: true });
      let end = pending.length - hold;
      // More at a time than is held back, so no character is searched more than twice.
      if (end <= hold) return;
      // Never between the two halves of one character.
      if (pending.codePointAt(end - 1)! > 0xffff) end -= 1;
      advance(end);
    },
    /** The output is over, so what was held back is shown too. */
    end: () => {
      if (!cut) {
        pending += decoder.decode();
        advance(pending.length);
      }
      return { text: utf8Decoder().decode(shown.subarray(0, used)), cut };
    },
    /** How much is kept: the bytes that come back, and the characters not shown yet. */
    held: () => used + pending.length,
  };
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
  const fileSystem = yield* FileSystem.FileSystem;
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

  /**
   * At most `OUTPUT_LIMIT` bytes of a stream once every secret in it is masked. The stream is
   * read to its end even past that, so a command never waits on a full pipe.
   */
  const collectMasked = (
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    secrets: ReadonlyArray<string>,
  ) =>
    stream.pipe(
      Stream.runFold(
        () => makeOutputMasker(secrets, OUTPUT_LIMIT),
        (masker, chunk) => {
          masker.write(chunk);
          return masker;
        },
      ),
      Effect.map((masker) => masker.end()),
      Effect.mapError(
        () =>
          new SecretCommandError({ reason: "failed", message: "The output could not be read." }),
      ),
    );

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
      const outside = () => invalid("`cwd` must be a relative path inside the thread's workspace.");
      const workspaceRoot = path.resolve(root);
      const requested = path.resolve(workspaceRoot, input.cwd ?? ".");
      if (path.isAbsolute(input.cwd ?? "") || !isWithinRoot(path, requested, workspaceRoot)) {
        return yield* outside();
      }
      // A symlink inside may lead out, so containment holds for the real paths, and the command
      // starts at the real one.
      const realRoot = yield* fileSystem
        .realPath(workspaceRoot)
        .pipe(
          Effect.mapError(() => invalid("This thread's workspace does not exist on this machine.")),
        );
      const cwd = yield* fileSystem
        .realPath(requested)
        .pipe(Effect.mapError(() => invalid("`cwd` does not exist in the thread's workspace.")));
      if (!isWithinRoot(path, cwd, realRoot)) return yield* outside();

      const command = displayCommand(input.command);
      const deadline = (yield* Clock.currentTimeMillis) + APPROVAL_TIMEOUT_MS;
      const resolved = new Map<string, Resolved>();
      for (const reference of [input.stdin, ...env.map(([, reference]) => reference)]) {
        if (reference === undefined || resolved.has(reference)) continue;
        const secret = yield* resolveSecret(caller, reference, command, deadline);
        if (Redacted.value(secret.value).trim().length < MIN_SECRET_LENGTH) {
          return yield* refused(
            `The secret at ${reference} is shorter than ${MIN_SECRET_LENGTH} characters, so it could not be masked in the command's output, and the command was not run. Ask the user to run it themselves.`,
          );
        }
        resolved.set(reference, secret);
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
        truncated: output.stdout.cut || output.stderr.cut,
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
