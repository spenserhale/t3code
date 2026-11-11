import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  SecretProviderId,
  SecretProviderKind,
  type SecretCommandInput,
  type SecretRelayAnswer,
  type SecretRelayStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BrowserLogins from "../preview/BrowserLogins.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as SecretCommands from "./SecretCommands.ts";
import * as SecretRelay from "./SecretRelay.ts";

const kind = SecretProviderKind.make("fake_vault");
const work = SecretProviderId.make("work");
const personal = SecretProviderId.make("personal");
const caller = { threadId: ThreadId.make("thread-a"), threadTitle: "Deploy", agent: "codex" };
const FIRECRAWL = "op://Agents/Firecrawl/key";
const OPENAI = "op://Employee/OpenAI/key";

/** What each account's vault holds. `work` signs in with a service account. */
const PEM = "-----BEGIN KEY-----\nMIIBsecretline\nxy\n-----END KEY-----\n";
const vaults: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  work: {
    [FIRECRAWL]: "fc-work-123",
    "op://Agents/Padded/key": "  padded-789\n",
    "op://Agents/Cert/pem": PEM,
    "op://Agents/Four/key": "wxyz",
    "op://Agents/Pin/code": "123",
    "op://Agents/PaddedPin/code": " 12\n",
  },
  personal: { [OPENAI]: "sk-personal-456" },
};
const SECRETS = ["fc-work-123", "padded-789", "sk-personal-456", "MIIBsecretline"];

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
  readonly stdin: Array<string>;
  readonly kills: Array<ChildProcess.KillOptions | undefined>;
}

/** A command's output, or `hang` to run until it is killed. */
interface FakeRun {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fakeSpawner = (answer: (spawned: Spawned) => FakeRun) => {
  const spawned: Array<Spawned> = [];
  const started = Deferred.makeUnsafe<void>();
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const {
          command: executable,
          args,
          options,
        } = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly options: ChildProcess.CommandOptions;
        };
        const record: Spawned = { command: executable, args, options, stdin: [], kills: [] };
        spawned.push(record);
        const run = answer(record);
        const exited = Deferred.makeUnsafe<ChildProcessSpawner.ExitCode>();
        if (!run.hang)
          Deferred.doneUnsafe(exited, Effect.succeed(ChildProcessSpawner.ExitCode(run.code ?? 0)));
        Deferred.doneUnsafe(started, Effect.void);
        const output = (text: string | undefined) =>
          run.hang ? Stream.never : Stream.make(encoder.encode(text ?? ""));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Deferred.await(exited),
          isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
          kill: (options) =>
            Effect.sync(() => {
              record.kills.push(options);
              Deferred.doneUnsafe(exited, Effect.succeed(ChildProcessSpawner.ExitCode(143)));
            }),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.sync(() => void record.stdin.push(decoder.decode(chunk))),
          ),
          stdout: output(run.stdout),
          stderr: output(run.stderr),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
  return { layer, spawned, started };
};

const setup = (
  options: {
    /** Whether a desktop app is attached to this server, and what its dialog answers in turn. */
    readonly desktop?: boolean;
    readonly answers?: Array<DesktopBrowserChannel.DesktopApproval>;
    /** The dialog itself, in place of answering from `answers`. */
    readonly approve?: DesktopBrowserChannel.DesktopBrowserChannel["Service"]["approveLogin"];
    readonly escalation?: "device" | "refuse";
    readonly workspaceRoot?: string;
    /** The real file system under the fake process; otherwise every path is its own real path. */
    readonly realFileSystem?: boolean;
    /** A real process and file system instead of the fakes. */
    readonly real?: boolean;
    readonly run?: (spawned: Spawned) => FakeRun;
  } = {},
) => {
  const reads: Array<string> = [];
  const prompts: Array<DesktopBrowserChannel.DesktopLoginPrompt> = [];
  /** How many password manager reads had run when each prompt was shown. */
  const readsBefore: Array<number> = [];
  const logs: Array<string> = [];
  const driver = defineSecretProviderDriver({
    kind,
    definition: defineSecretProvider({
      kind,
      label: "Fake Vault",
      configSchema: Schema.Struct({
        account: Schema.String,
        serviceAccountToken: Schema.optional(Schema.String),
      }),
      isReference: (reference) => reference.startsWith("op://"),
      referencePlaceholder: "",
      invalidReferenceMessage: "",
      supportsLogins: true,
    }),
    read: ({ account }, references) =>
      Effect.sync(() =>
        references.map((reference) => {
          reads.push(`${account}:${reference}`);
          return vaults[account]?.[reference];
        }),
      ),
    unattended: ({ serviceAccountToken }) => serviceAccountToken !== undefined,
    logins: { list: () => Effect.succeed([]), read: () => Effect.sync(() => undefined) },
  });
  const settings = Settings.layerTest({
    secretProviders: {
      [work]: { kind, label: "Work", config: { account: "work", serviceAccountToken: "ops_work" } },
      [personal]: { kind, label: "Personal", config: { account: "personal" } },
    },
    browserLogins: {
      secretProviderIds: [work, personal],
      approval: "thread",
      ...(options.escalation ? { escalation: options.escalation } : {}),
    },
  });
  const browserLogins = Layer.effect(
    BrowserLogins.BrowserLogins,
    BrowserLogins.make([driver]),
  ).pipe(
    Layer.provideMerge(settings),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const channel = Layer.succeed(DesktopBrowserChannel.DesktopBrowserChannel, {
    available: options.desktop ?? false,
    awaitAttached: () => Effect.succeed(false),
    detached: Stream.empty,
    attached: Stream.empty,
    isAttached: () => Effect.succeed(false),
    endpoint: () => Effect.die("No tab is drawn here."),
    pointer: () => Effect.void,
    turn: () => Effect.void,
    loginFilled: () => Effect.void,
    approveLogin: (key, timeoutMs, prompt) =>
      Effect.suspend(() => {
        prompts.push(prompt);
        readsBefore.push(reads.length);
        return (
          options.approve?.(key, timeoutMs, prompt) ??
          Effect.succeed(options.answers?.shift() ?? false)
        );
      }),
  });
  const thread = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({
          id: caller.threadId,
          title: caller.threadTitle,
          worktreePath: options.workspaceRoot ?? "/work/repo",
        } as never),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
  );
  const processes = fakeSpawner(options.run ?? (() => ({ stdout: "ok" })));
  const layer = SecretCommands.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        browserLogins,
        channel,
        SecretRelay.layer,
        thread,
        options.real
          ? NodeServices.layer
          : Layer.mergeAll(
              processes.layer,
              NodePath.layer,
              options.realFileSystem
                ? NodeFileSystem.layer
                : FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) }),
            ),
      ),
    ),
    Layer.provideMerge(
      Logger.layer([Logger.map(Logger.formatJson, (line) => void logs.push(line))], {
        mergeWithExisting: false,
      }),
    ),
  );
  return { layer, reads, prompts, readsBefore, logs, processes };
};

const run = (input: SecretCommandInput) =>
  SecretCommands.SecretCommands.pipe(Effect.flatMap((commands) => commands.run(caller, input)));

const reveal = (env: ChildProcess.CommandOptions["env"]) =>
  Object.fromEntries(
    Object.entries(env ?? {}).map(([name, value]) => [
      name,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

/** The user's device, answering the requests relayed to it with `answer`. */
const device = (
  answer: (reference: string) => Parameters<SecretRelay.SecretRelay["Service"]["answer"]>[1],
) =>
  Effect.gen(function* () {
    const relay = yield* SecretRelay.SecretRelay;
    const asked = yield* Queue.unbounded<SecretRelayStreamItem>();
    yield* relay.subscribe(["secretReference"], "laptop").pipe(
      Stream.runForEach((item) =>
        item.type === "request"
          ? Queue.offer(asked, item).pipe(
              Effect.andThen(
                relay.answer(
                  item.request.requestId,
                  answer(item.request.reference ?? ""),
                  "laptop",
                ),
              ),
            )
          : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return asked;
  });

describe("SecretCommands", () => {
  it.effect(
    "uses a service account here without asking, and passes secrets on stdin and in env",
    () => {
      const fixture = setup({ desktop: true });
      return Effect.gen(function* () {
        const result = yield* run({
          command: ["wide-search", "auth", "set", "firecrawl", "--stdin"],
          stdin: FIRECRAWL,
          env: { FIRECRAWL_KEY: FIRECRAWL },
          cwd: "tools",
        });
        assert.deepStrictEqual(result, {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          truncated: false,
          sources: {
            stdin: { type: "serviceAccount", label: "Work" },
            env: { FIRECRAWL_KEY: { type: "serviceAccount", label: "Work" } },
          },
        });
        // Read once for both uses, from the service account alone, with nobody asked.
        assert.deepStrictEqual(fixture.reads, [`work:${FIRECRAWL}`]);
        assert.deepStrictEqual(fixture.prompts, []);
        const [spawned] = fixture.processes.spawned;
        assert.strictEqual(spawned?.command, "wide-search");
        assert.deepStrictEqual(spawned?.args, ["auth", "set", "firecrawl", "--stdin"]);
        assert.strictEqual(spawned?.options.cwd, "/work/repo/tools");
        assert.isTrue(spawned?.options.extendEnv);
        assert.deepStrictEqual(reveal(spawned?.options.env), { FIRECRAWL_KEY: "fc-work-123" });
        // Redacted on its way to the spawner, so nothing that prints the command shows it.
        assert.isTrue(Redacted.isRedacted(spawned?.options.env?.FIRECRAWL_KEY));
        assert.strictEqual(spawned?.options.stdin, "pipe");
        assert.deepStrictEqual(spawned?.stdin, ["fc-work-123\n"]);

        yield* run({ command: ["env"], env: { FIRECRAWL_KEY: FIRECRAWL } });
        // Without a secret for stdin, a command reading it finds it empty instead of waiting.
        assert.strictEqual(fixture.processes.spawned[1]?.options.stdin, "ignore");
        assert.isFalse(
          fixture.logs.some((line) => SECRETS.some((secret) => line.includes(secret))),
        );
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("asks in this machine's desktop app for what only a person can unlock", () => {
    const fixture = setup({ desktop: true, answers: [false, "thread"] });
    return Effect.gen(function* () {
      const input = { command: ["openai", "models", "list"], env: { OPENAI_API_KEY: OPENAI } };
      const denied = yield* run(input).pipe(Effect.flip);
      assert.deepStrictEqual(
        { reason: denied.reason, message: denied.message },
        { reason: "refused", message: "The user did not approve using this secret in a command." },
      );
      // The service account is tried first; the person's password manager only once allowed.
      assert.deepStrictEqual(fixture.reads, [`work:${OPENAI}`]);
      assert.deepStrictEqual(fixture.readsBefore, [1]);
      assert.deepStrictEqual(fixture.prompts, [
        {
          kind: "secretReference",
          providerLabel: "Personal",
          reference: OPENAI,
          command: "openai models list",
          threadTitle: "Deploy",
          agent: "codex",
        },
      ]);
      assert.lengthOf(fixture.processes.spawned, 0);

      const allowed = yield* run(input);
      assert.deepStrictEqual(fixture.readsBefore, [1, 2]);
      assert.deepStrictEqual(fixture.reads.slice(1), [`work:${OPENAI}`, `personal:${OPENAI}`]);
      assert.deepStrictEqual(allowed.sources, { env: { OPENAI_API_KEY: { type: "device" } } });
      assert.deepStrictEqual(reveal(fixture.processes.spawned[0]?.options.env), {
        OPENAI_API_KEY: "sk-personal-456",
      });
      // Allowed for this thread: asked no more.
      yield* run(input);
      assert.lengthOf(fixture.prompts, 2);
      assert.isFalse(fixture.logs.some((line) => SECRETS.some((secret) => line.includes(secret))));
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("relays to the user's device when nobody here can ask, else refuses", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const input = { command: ["openai", "models", "list"], stdin: OPENAI };
      const nobody = yield* run(input).pipe(Effect.flip);
      assert.strictEqual(nobody.reason, "refused");
      assert.include(nobody.message, "no T3 Code desktop app that can ask the user is connected");

      const asked = yield* device(() => ({
        type: "values",
        item: { id: OPENAI, title: OPENAI, urls: [] },
        values: { value: Redacted.make("sk-from-device") },
      }));
      const result = yield* run(input);
      assert.deepStrictEqual(result.sources, { stdin: { type: "device" } });
      assert.deepStrictEqual(fixture.processes.spawned[0]?.stdin, ["sk-from-device\n"]);
      const relayed = yield* Queue.take(asked);
      assert.deepStrictEqual(
        relayed.type === "request" && { ...relayed.request, requestId: "", expiresAt: 0 },
        {
          requestId: "",
          kind: "secretReference",
          threadId: "thread-a",
          threadTitle: "Deploy",
          agent: "codex",
          reference: OPENAI,
          command: "openai models list",
          expiresAt: 0,
        },
      );
      // Only this machine's service account was read; the attended one is the device's to ask.
      assert.deepStrictEqual(fixture.reads, [`work:${OPENAI}`, `work:${OPENAI}`]);

      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({
        browserLogins: {
          secretProviderIds: [work, personal],
          approval: "thread",
          escalation: "refuse",
        },
      });
      const refused = yield* run(input).pipe(Effect.flip);
      assert.include(refused.message, "this machine is set not to ask the user's device");
      assert.lengthOf(fixture.processes.spawned, 1);
      assert.isFalse(fixture.logs.some((line) => line.includes("sk-from-device")));
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.effect("passes on why the user's device said no", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const answers = [
        { type: "denied" },
        { type: "none" },
        { type: "unavailable", message: "Personal did not return it." },
      ] as const;
      let answered = 0;
      yield* device(() => answers[answered++]!);
      const messages = yield* Effect.forEach(answers, () =>
        run({ command: ["true"], stdin: OPENAI }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        ),
      );
      assert.lengthOf(fixture.processes.spawned, 0);
      assert.deepStrictEqual(messages, [
        "The user did not approve using this secret in a command on their device.",
        `No password manager can open ${OPENAI}.`,
        "The user's device could not answer: Personal did not return it.",
      ]);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.effect("passes over a device that answers without the secret for one that has it", () => {
    const fixture = setup();
    const item = { id: OPENAI, title: OPENAI, urls: [] };
    return Effect.gen(function* () {
      const relay = yield* SecretRelay.SecretRelay;
      const requests = yield* Queue.unbounded<string>();
      yield* relay.subscribe(["secretReference"], "old").pipe(
        Stream.runForEach((asked) =>
          asked.type === "request" ? Queue.offer(requests, asked.request.requestId) : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* relay
        .subscribe(["secretReference"], "laptop")
        .pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }));
      const answered = (laptop: SecretRelayAnswer) =>
        Effect.gen(function* () {
          const call = yield* run({ command: ["openai", "models", "list"], stdin: OPENAI }).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          const requestId = yield* Queue.take(requests);
          // An older device answers first, with whatever it read.
          yield* relay.answer(requestId, { type: "values", item, values: {} }, "old");
          yield* relay.answer(requestId, laptop, "laptop");
          return yield* Fiber.join(call);
        });

      const result = yield* answered({
        type: "values",
        item,
        values: { value: Redacted.make("sk-from-device") },
      });
      assert.deepStrictEqual(result.sources, { stdin: { type: "device" } });
      assert.deepStrictEqual(fixture.processes.spawned[0]?.stdin, ["sk-from-device\n"]);

      // On no device at all, it ends as it does when nobody has the secret.
      const nobody = yield* answered({ type: "none" }).pipe(Effect.flip);
      assert.strictEqual(nobody.message, `No password manager can open ${OPENAI}.`);
      assert.lengthOf(fixture.processes.spawned, 1);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.effect("set to refuse, stops after the service accounts, before any dialog or read", () => {
    const fixture = setup({ desktop: true, escalation: "refuse", answers: ["once"] });
    return Effect.gen(function* () {
      const asked = yield* device(() => ({
        type: "values",
        item: { id: OPENAI, title: OPENAI, urls: [] },
        values: { value: Redacted.make("sk-from-device") },
      }));
      const error = yield* run({ command: ["openai", "models", "list"], stdin: OPENAI }).pipe(
        Effect.flip,
      );
      assert.strictEqual(error.reason, "refused");
      assert.include(error.message, "this machine is set not to ask the user's device");
      assert.deepStrictEqual(fixture.reads, [`work:${OPENAI}`]);
      assert.deepStrictEqual(fixture.prompts, []);
      assert.isTrue(Option.isNone(yield* Queue.poll(asked)));
      assert.lengthOf(fixture.processes.spawned, 0);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.effect(
    "passes a secret this machine's password managers do not have on to the user's device",
    () => {
      const missing = "op://Employee/Elsewhere/key";
      const fixture = setup({ desktop: true, answers: ["once"] });
      return Effect.gen(function* () {
        const asked = yield* device(() => ({
          type: "values",
          item: { id: missing, title: missing, urls: [] },
          values: { value: Redacted.make("sk-from-device") },
        }));
        const result = yield* run({ command: ["openai", "models", "list"], stdin: missing });
        assert.deepStrictEqual(result.sources, { stdin: { type: "device" } });
        assert.deepStrictEqual(fixture.processes.spawned[0]?.stdin, ["sk-from-device\n"]);
        // Asked here first, read here, and only then relayed.
        assert.deepStrictEqual(fixture.reads, [`work:${missing}`, `personal:${missing}`]);
        assert.lengthOf(fixture.prompts, 1);
        assert.strictEqual((yield* Queue.take(asked)).type, "request");
      }).pipe(Effect.scoped, Effect.provide(fixture.layer));
    },
  );

  it.effect("cancelling the call closes this machine's dialog before anything is read", () => {
    const opened = Deferred.makeUnsafe<void>();
    const closed = Deferred.makeUnsafe<void>();
    const fixture = setup({
      desktop: true,
      approve: () =>
        Deferred.succeed(opened, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(closed, undefined)),
        ),
    });
    return Effect.gen(function* () {
      const call = yield* run({ command: ["true"], stdin: OPENAI }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(opened);
      yield* Fiber.interrupt(call);
      yield* Deferred.await(closed);
      assert.deepStrictEqual(fixture.reads, [`work:${OPENAI}`]);
      assert.lengthOf(fixture.processes.spawned, 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("cancelling the call ends its request on the user's device", () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const relay = yield* SecretRelay.SecretRelay;
      const items = yield* Queue.unbounded<SecretRelayStreamItem>();
      yield* relay.subscribe(["secretReference"], "laptop").pipe(
        Stream.runForEach((item) => Queue.offer(items, item)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const call = yield* run({ command: ["true"], stdin: OPENAI }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const asked = yield* Queue.take(items);
      if (asked.type !== "request") throw new Error("Expected the relayed request first.");
      yield* Fiber.interrupt(call);
      assert.deepStrictEqual(yield* Queue.take(items), {
        type: "ended",
        requestId: asked.request.requestId,
      });
      // A late answer runs nothing.
      yield* relay.answer(
        asked.request.requestId,
        {
          type: "values",
          item: { id: OPENAI, title: OPENAI, urls: [] },
          values: { value: Redacted.make("sk-late") },
        },
        "laptop",
      );
      assert.lengthOf(fixture.processes.spawned, 0);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.effect(
    "masks every secret, its trimmed form and its lines included, in stdout and stderr",
    () => {
      const fixture = setup({
        run: () => ({
          stdout: `key=fc-work-123\npadded=  padded-789\n\ntrimmed=padded-789.\n${PEM}line=MIIBsecretline\nshort=xy\n`,
          stderr: "warning: fc-work-123 is a test key",
          code: 3,
        }),
      });
      return Effect.gen(function* () {
        const result = yield* run({
          command: ["print"],
          stdin: FIRECRAWL,
          env: { PADDED: "op://Agents/Padded/key", CERT: "op://Agents/Cert/pem" },
        });
        assert.deepStrictEqual(result, {
          exitCode: 3,
          // A line of a multi-line secret is masked on its own; one under 4 characters is not.
          stdout:
            "key=[secret]\npadded=[secret]\ntrimmed=[secret].\n[secret]line=[secret]\nshort=xy\n",
          stderr: "warning: [secret] is a test key",
          truncated: false,
          sources: {
            stdin: { type: "serviceAccount", label: "Work" },
            env: {
              PADDED: { type: "serviceAccount", label: "Work" },
              CERT: { type: "serviceAccount", label: "Work" },
            },
          },
        });
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("refuses a secret too short to mask, before asking for the next one", () => {
    const fixture = setup({ desktop: true, answers: ["once"] });
    return Effect.gen(function* () {
      for (const reference of ["op://Agents/Pin/code", "op://Agents/PaddedPin/code"]) {
        const error = yield* run({
          command: ["print"],
          stdin: reference,
          env: { OPENAI_API_KEY: OPENAI },
        }).pipe(Effect.flip);
        assert.deepStrictEqual(
          { reason: error.reason, message: error.message },
          {
            reason: "refused",
            message: `The secret at ${reference} is shorter than 4 characters, so it could not be masked in the command's output, and the command was not run. Ask the user to run it themselves.`,
          },
        );
      }
      assert.deepStrictEqual(fixture.prompts, []);
      assert.lengthOf(fixture.processes.spawned, 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect(
    "returns at most 64 KiB of each masked stream, never part of a mask or a secret",
    () => {
      const limit = 64 * 1024;
      const mask = SecretCommands.SECRET_MASK;
      const outputs = [
        // A secret just before the cap: its mask does not fit, so neither shows.
        `${"a".repeat(limit - 3)}fc-work-123 and more`,
        // Two bytes a character: the cap falls just before the secret, which must not show at all.
        `${"é".repeat(limit / 2 + 2)}fc-work-123 and more`,
        // Masks longer than what they hide: the cap counts what comes back.
        `${"wxyz ".repeat(13_107)}w`,
        // Masks shorter than what they hide: over 64 KiB in, all of it back, nothing cut.
        "fc-work-123\n".repeat(5_462),
      ];
      const fixture = setup({ run: () => ({ stdout: outputs.shift() ?? "" }) });
      return Effect.gen(function* () {
        const straddling = yield* run({ command: ["print"], stdin: FIRECRAWL });
        assert.strictEqual(straddling.stdout, "a".repeat(limit - 3));
        assert.isTrue(straddling.truncated);
        const multibyte = yield* run({ command: ["print"], stdin: FIRECRAWL });
        assert.isTrue(multibyte.truncated);
        assert.notInclude(multibyte.stdout, "fc-");
        assert.match(multibyte.stdout, /^é+$/);
        const expanding = yield* run({ command: ["print"], stdin: "op://Agents/Four/key" });
        assert.strictEqual(expanding.stdout, `${mask} `.repeat(7_281));
        assert.isTrue(expanding.truncated);
        const shrinking = yield* run({ command: ["print"], stdin: FIRECRAWL });
        assert.strictEqual(shrinking.stdout, `${mask}\n`.repeat(5_462));
        assert.isFalse(shrinking.truncated);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("reads past 64 KiB of output to its end when what comes back fits", () => {
    // 72,008 bytes from the command, 54,008 once masked.
    const fixture = setup({
      run: () => ({ stdout: `${"fc-work-123\n".repeat(6_000)}SUCCESS\n` }),
    });
    return Effect.gen(function* () {
      const result = yield* run({ command: ["print"], stdin: FIRECRAWL });
      assert.strictEqual(
        result.stdout,
        `${`${SecretCommands.SECRET_MASK}\n`.repeat(6_000)}SUCCESS\n`,
      );
      assert.isFalse(result.truncated);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("stops a command that runs past its timeout through its handle", () => {
    const fixture = setup({ run: () => ({ hang: true }) });
    return Effect.gen(function* () {
      const running = yield* run({
        command: ["sleep", "600"],
        stdin: FIRECRAWL,
        timeoutMs: 5_000,
      }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(fixture.processes.started);
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(running);
      assert.deepStrictEqual(
        { reason: error.reason, message: error.message },
        {
          reason: "timeout",
          message: "The command did not finish within 5000 ms, so it was stopped.",
        },
      );
      assert.lengthOf(fixture.processes.spawned[0]?.kills ?? [], 1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("refuses a cwd outside the workspace before asking for any secret", () => {
    const fixture = setup({ desktop: true });
    return Effect.gen(function* () {
      for (const cwd of ["..", "../other", "tools/../../other", "/work/repo/tools"]) {
        const error = yield* run({ command: ["ls"], stdin: OPENAI, cwd }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid", cwd);
      }
      assert.deepStrictEqual(fixture.reads, []);
      assert.deepStrictEqual(fixture.prompts, []);
      assert.lengthOf(fixture.processes.spawned, 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("refuses a cwd a symlink leads out of the workspace, and runs at the real path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-secret-command-cwd-" });
      const root = `${base}/repo`;
      yield* fileSystem.makeDirectory(`${root}/tools`, { recursive: true });
      yield* fileSystem.makeDirectory(`${base}/outside/deeper`, { recursive: true });
      yield* fileSystem.symlink(`${base}/outside`, `${root}/escape`);
      yield* fileSystem.symlink(`${root}/tools`, `${root}/linked`);
      const realRoot = yield* fileSystem.realPath(root);
      const fixture = setup({ workspaceRoot: root, realFileSystem: true, desktop: true });
      yield* Effect.gen(function* () {
        for (const cwd of ["escape", "escape/deeper"]) {
          const error = yield* run({ command: ["ls"], stdin: OPENAI, cwd }).pipe(Effect.flip);
          assert.deepStrictEqual(
            { reason: error.reason, message: error.message },
            {
              reason: "invalid",
              message: "`cwd` must be a relative path inside the thread's workspace.",
            },
            cwd,
          );
        }
        assert.deepStrictEqual(fixture.reads, []);
        assert.deepStrictEqual(fixture.prompts, []);
        assert.lengthOf(fixture.processes.spawned, 0);
        // A symlink that stays inside is followed, and the command starts where it leads.
        yield* run({ command: ["ls"], stdin: FIRECRAWL, cwd: "linked" });
        assert.strictEqual(fixture.processes.spawned[0]?.options.cwd, `${realRoot}/tools`);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("runs a real command with its secrets and masks what it prints", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-secret-command-" });
      yield* fileSystem.makeDirectory(`${root}/tools`);
      const fixture = setup({ workspaceRoot: root, real: true });
      const script = [
        'let input = "";',
        'process.stdin.on("data", (chunk) => (input += chunk));',
        'process.stdin.on("end", () => {',
        '  console.log("cwd=" + require("node:path").basename(process.cwd()));',
        '  console.log("env=" + process.env.FIRECRAWL_KEY);',
        '  console.log("stdin=" + JSON.stringify(input));',
        '  console.log("trimmed=" + process.env.PADDED.trim());',
        '  console.error("err=" + input.trim());',
        "});",
      ].join("\n");
      const result = yield* run({
        command: [process.execPath, "-e", script],
        stdin: FIRECRAWL,
        env: { FIRECRAWL_KEY: FIRECRAWL, PADDED: "op://Agents/Padded/key" },
        cwd: "tools",
      }).pipe(Effect.provide(fixture.layer));
      assert.deepStrictEqual(
        { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
        {
          exitCode: 0,
          stdout: 'cwd=tools\nenv=[secret]\nstdin="[secret]\\n"\ntrimmed=[secret]\n',
          stderr: "err=[secret]\n",
        },
      );
      assert.isFalse(SECRETS.some((secret) => JSON.stringify(result).includes(secret)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reads tens of megabytes from a real command to the end, with its exit code", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-secret-command-" });
      const fixture = setup({ workspaceRoot: root, real: true });
      const mask = SecretCommands.SECRET_MASK;
      const script = [
        "const key = process.env.FIRECRAWL_KEY;",
        // 33 MB of one key after another is a single mask, so stdout never reaches its cap.
        "const keys = Buffer.from(key.repeat(100_000));",
        "for (let block = 0; block < 30; block++) process.stdout.write(keys);",
        'process.stdout.write("SUCCESS\\n");',
        // 32 MB of lines that are 16 bytes once masked: 4,096 of them fill stderr's cap.
        'const lines = Buffer.from(("0123456" + key + "\\n").repeat(100_000));',
        "for (let block = 0; block < 17; block++) process.stderr.write(lines);",
        "process.exitCode = 7;",
      ].join("\n");
      const result = yield* run({
        command: [process.execPath, "-e", script],
        env: { FIRECRAWL_KEY: FIRECRAWL },
      }).pipe(Effect.provide(fixture.layer));
      assert.deepStrictEqual(
        {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        },
        {
          exitCode: 7,
          stdout: `${mask}SUCCESS\n`,
          stderr: `0123456${mask}\n`.repeat(4_096),
          truncated: true,
        },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("makeOutputMasker", () => {
  /** What comes back for output that arrives in these chunks. */
  const maskChunks = (
    chunks: ReadonlyArray<Uint8Array>,
    secrets: ReadonlyArray<string>,
    maxBytes: number,
  ) => {
    const masker = SecretCommands.makeOutputMasker(secrets, maxBytes);
    for (const chunk of chunks) masker.write(chunk);
    return masker.end();
  };

  /** The same for `text` whole, a byte at a time, and cut anywhere into two chunks or three. */
  const maskSecrets = (text: string, secrets: ReadonlyArray<string>, maxBytes: number) => {
    const bytes = encoder.encode(text);
    const whole = maskChunks([bytes], secrets, maxBytes);
    const single = Array.from(bytes, (_, at) => bytes.subarray(at, at + 1));
    assert.deepStrictEqual(
      maskChunks(single, secrets, maxBytes),
      whole,
      `${text} a byte at a time`,
    );
    for (let first = 0; first <= bytes.length; first++) {
      for (let second = first; second <= bytes.length; second++) {
        assert.deepStrictEqual(
          maskChunks(
            [bytes.subarray(0, first), bytes.subarray(first, second), bytes.subarray(second)],
            secrets,
            maxBytes,
          ),
          whole,
          `${text} cut at ${first} and ${second}`,
        );
      }
    }
    return whole;
  };

  it("masks overlapping, contained, touching and repeated matches as one, leaving no part", () => {
    const mask = SecretCommands.SECRET_MASK;
    for (const [text, secrets, masked] of [
      // Two secrets overlapping, in either order.
      ["abcde", ["abc", "bcde"], mask],
      ["xxabcdeyy", ["bcde", "abc"], `xx${mask}yy`],
      // One inside another.
      ["xabcdefx", ["bcd", "abcdef"], `x${mask}x`],
      // Touching, and a secret overlapping its own next copy.
      ["abcdwxyz", ["abcd", "wxyz"], mask],
      ["ababab-abab", ["abab"], `${mask}-${mask}`],
      // A trimmed form, and a line of a multi-line secret, overlapping another secret.
      ["key=padded-789xyz", ["  padded-789\n", "789xyz"], `key=${mask}`],
      ["BBBBCCDDDD", ["AAAA\nBBBBCC", "CCDDDD"], mask],
    ] as const) {
      assert.deepStrictEqual(maskSecrets(text, secrets, 100), { text: masked, cut: false }, text);
    }
  });

  it("masks the same wherever chunks divide a secret, its lines or a character beside it", () => {
    const mask = SecretCommands.SECRET_MASK;
    for (const [text, secrets, shown] of [
      // One secret.
      ["key=fc-work-123;", ["fc-work-123"], `key=${mask};`],
      // Two that overlap, one inside another, ones that touch, and one that repeats.
      ["xxabcdeyy", ["bcde", "abc"], `xx${mask}yy`],
      ["xabcdefx", ["bcd", "abcdef"], `x${mask}x`],
      ["abcdwxyz-ababab-abab", ["abcd", "wxyz", "abab"], `${mask}-${mask}-${mask}`],
      // A multi-line secret whole, then one of its lines alone.
      [`a ${PEM}b MIIBsecretline c`, [PEM], `a ${mask}b ${mask} c`],
      // Characters of two, three and four bytes, beside a secret and inside one.
      [
        "é€😀fc-work-123😀€é p€ss😀wörd!",
        ["fc-work-123", "p€ss😀wörd"],
        `é€😀${mask}😀€é ${mask}!`,
      ],
    ] as const) {
      // More than a secret's length on each side, so a chunk can end at every offset between.
      const pad = ".".repeat(1 + Math.max(...secrets.map((secret) => secret.length)));
      assert.deepStrictEqual(
        maskSecrets(`${pad}${text}${pad}`, secrets, 1_000),
        { text: `${pad}${shown}${pad}`, cut: false },
        text,
      );
    }
    // Each line of a multi-line secret in a chunk of its own, between two of other output.
    const lines = [".".repeat(60), ...PEM.split(/(?<=\n)/), ".".repeat(60)];
    assert.deepStrictEqual(
      maskChunks(
        lines.map((line) => encoder.encode(line)),
        [PEM],
        1_000,
      ),
      { text: `${".".repeat(60)}${mask}${".".repeat(60)}`, cut: false },
    );
    // A byte order mark stays; bytes that are no character, the last ones too, become U+FFFD.
    const stray = [
      Uint8Array.of(0xef, 0xbb, 0xbf, 0xff),
      encoder.encode("fc-work-123"),
      Uint8Array.of(0xe2, 0x82),
    ];
    assert.deepStrictEqual(maskChunks(stray, ["fc-work-123"], 1_000), {
      text: `\uFEFF\uFFFD${mask}\uFFFD`,
      cut: false,
    });
  });

  it("returns at most the bytes asked, never part of a mask, a character or a secret", () => {
    const mask = SecretCommands.SECRET_MASK;
    const secrets = ["abcdef", " pad "];
    for (const [text, maxBytes, shown] of [
      ["xx abcdef yy pad", 100, { text: `xx ${mask} yy ${mask}`, cut: false }],
      // A mask fits whole or not at all.
      ["1234abcdef5678", 12, { text: `1234${mask}`, cut: true }],
      ["1234abcdef5678", 11, { text: "1234", cut: true }],
      ["12345678abcdef", 5, { text: "12345", cut: true }],
      // Text is cut between characters.
      ["aéé", 4, { text: "aé", cut: true }],
      // A character of four bytes counts as four, wherever it was held back.
      ["x😀😀😀😀😀😀", 25, { text: "x😀😀😀😀😀😀", cut: false }],
      // A run that goes on past a full cap leaves nothing out; anything after it does.
      ["abcdefabcdef", 8, { text: mask, cut: false }],
      ["abcdefabcdef!", 8, { text: mask, cut: true }],
      // Nothing follows a cut: not text that would fit, nor a character it stopped in.
      ["1234abcdef5678 and moré", 11, { text: "1234", cut: true }],
      ["a😀abcdefxyabcdef", 4, { text: "a", cut: true }],
    ] as const) {
      assert.deepStrictEqual(maskSecrets(text, secrets, maxBytes), shown, `${text} ${maxBytes}`);
    }
    // A mask is never masked again, even by a secret that reads "secret".
    assert.deepStrictEqual(maskSecrets("abcdefgh", ["abc", "abcdefgh", "secret"], 100), {
      text: mask,
      cut: false,
    });
  });

  it("keeps what comes back and under two secrets' length more, however much is written", () => {
    const mask = SecretCommands.SECRET_MASK;
    const limit = 64 * 1024;
    const secret = "fc-work-123";
    /** Writes 32 MiB of `line` over and over, in chunks that cut it anywhere: the most kept. */
    const flood = (masker: ReturnType<typeof SecretCommands.makeOutputMasker>, line: string) => {
      const size = 60_000;
      const lines = encoder.encode(line.repeat(Math.ceil(size / line.length) + 1));
      let most = 0;
      let written = 0;
      for (; written < 32 * 1024 * 1024; written += size) {
        const from = written % line.length;
        masker.write(lines.subarray(from, from + size));
        most = Math.max(most, masker.held());
      }
      // What is left of the line the last chunk stopped in.
      masker.write(lines.subarray(written % line.length, line.length));
      return most;
    };

    // One secret after another is a single mask, so the cap is never reached and all is read.
    const endless = SecretCommands.makeOutputMasker([secret], limit);
    assert.isAtMost(flood(endless, secret), mask.length + 2 * secret.length);
    endless.write(encoder.encode("SUCCESS"));
    assert.deepStrictEqual(endless.end(), { text: `${mask}SUCCESS`, cut: false });

    // Past the cap nothing more is kept: 4,681 masked lines and two bytes are 64 KiB exactly.
    const capped = SecretCommands.makeOutputMasker([secret], limit);
    assert.isAtMost(flood(capped, `line ${secret}\n`), limit + 2 * secret.length);
    assert.strictEqual(capped.held(), limit);
    assert.deepStrictEqual(capped.end(), {
      text: `${`line ${mask}\n`.repeat(4_681)}li`,
      cut: true,
    });
  });
});
