import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  SecretProviderId,
  SecretProviderKind,
  type SecretCommandInput,
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
    /** A real process instead of the fake. */
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
        options.real ? NodeServices.layer : Layer.merge(processes.layer, NodePath.layer),
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

  it.effect("cuts long output at about 64 KB without leaving part of a secret", () => {
    const limit = 64 * 1024;
    const outputs = [
      // A secret that starts just before the cut is masked whole.
      `${"a".repeat(limit - 3)}fc-work-123 and more`,
      // Two bytes a character: the capture stops inside the secret, which must not show at all.
      `${"é".repeat(limit / 2 + 2)}fc-work-123 and more`,
    ];
    const fixture = setup({ run: () => ({ stdout: outputs.shift() ?? "" }) });
    return Effect.gen(function* () {
      const straddling = yield* run({ command: ["print"], stdin: FIRECRAWL });
      assert.strictEqual(
        straddling.stdout,
        `${"a".repeat(limit - 3)}${SecretCommands.SECRET_MASK}`,
      );
      assert.isTrue(straddling.truncated);
      const multibyte = yield* run({ command: ["print"], stdin: FIRECRAWL });
      assert.isTrue(multibyte.truncated);
      assert.notInclude(multibyte.stdout, "fc-");
      assert.match(multibyte.stdout, /^é+$/);
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
});

describe("maskSecrets", () => {
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
      assert.deepStrictEqual(
        SecretCommands.maskSecrets(text, secrets, 100),
        { text: masked, cut: false },
        text,
      );
    }
  });

  it("masks whole any secret that starts before the cut, and never leaves part of one", () => {
    const secrets = ["abcdef", " pad "];
    assert.deepStrictEqual(SecretCommands.maskSecrets("xx abcdef yy pad", secrets, 100), {
      text: `xx ${SecretCommands.SECRET_MASK} yy ${SecretCommands.SECRET_MASK}`,
      cut: false,
    });
    // Starts before the cut at 5: masked whole. Past it: dropped with the rest.
    assert.deepStrictEqual(SecretCommands.maskSecrets("1234abcdef5678abcdef", secrets, 5), {
      text: `1234${SecretCommands.SECRET_MASK}`,
      cut: true,
    });
    assert.deepStrictEqual(SecretCommands.maskSecrets("12345678abcdef", secrets, 5), {
      text: "12345",
      cut: true,
    });
    // The longer secret wins where two start together, and the mask is never masked again.
    assert.deepStrictEqual(
      SecretCommands.maskSecrets("abcdefgh", ["abc", "abcdefgh", "secret"], 100),
      {
        text: SecretCommands.SECRET_MASK,
        cut: false,
      },
    );
  });
});
