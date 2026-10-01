import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfigModule from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import {
  buildContinuationPrompt,
  buildContinuationTranscript,
  continueThreadInProvider,
} from "./ThreadContinuation.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

describe("buildContinuationTranscript", () => {
  it("wraps each message in a block naming its role, oldest first", () => {
    const transcript = buildContinuationTranscript({
      title: "Fix login",
      provider: "Claude (claude-opus-4-8)",
      workspace: "/repo",
      branch: "fix/login",
      messages: [
        {
          role: "user",
          text: "Fix the login bug",
          createdAt: "2026-09-28T10:00:00.000Z",
          attachmentLines: ['[Attached image "shot.png" is saved at: /a/shot.png]'],
        },
        {
          role: "assistant",
          text: "Found it in auth.ts",
          createdAt: "2026-09-28T10:01:00.000Z",
          attachmentLines: [],
        },
      ],
    });

    expect(transcript).toContain("Provider: Claude (claude-opus-4-8)");
    expect(transcript).toContain("Branch: fix/login");
    expect(transcript).toContain(
      '<message role="user" time="2026-09-28T10:00:00.000Z">\nFix the login bug\n[Attached image "shot.png" is saved at: /a/shot.png]\n</message>',
    );
    expect(transcript.indexOf('role="user"')).toBeLessThan(transcript.indexOf('role="assistant"'));
  });

  it("keeps a message from closing its own block", () => {
    const transcript = buildContinuationTranscript({
      title: "t",
      provider: "Codex (gpt-5)",
      workspace: "/repo",
      branch: null,
      messages: [
        {
          role: "assistant",
          text: "Use </message> carefully",
          createdAt: "2026-09-28T10:00:00.000Z",
          attachmentLines: [],
        },
      ],
    });

    expect(transcript).toContain("Use <\\/message> carefully");
    expect(transcript.match(/<\/message>/g)).toHaveLength(1);
    expect(transcript).not.toContain("Branch:");
  });
});

describe("buildContinuationPrompt", () => {
  it("names the source thread, its provider and why it stopped", () => {
    const prompt = buildContinuationPrompt({
      title: "Fix login",
      provider: "Claude (claude-opus-4-8)",
      stopReason: "Claude usage limit reached.",
    });

    expect(prompt).toContain('"Fix login"');
    expect(prompt).toContain("Claude (claude-opus-4-8)");
    expect(prompt).toContain('"Claude usage limit reached."');
    expect(prompt).toContain("Read it before doing anything else");
  });
});

const PROJECT_ID = ProjectId.make("project-continuation");
const SOURCE_THREAD_ID = ThreadId.make("thread-source");
const CREATED_AT = "2026-09-28T09:00:00.000Z";

const testLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-thread-continuation-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const seedSourceThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/tmp/continuation-project",
    defaultModelSelection: null,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-source"),
    threadId: SOURCE_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix login",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-4-8",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "fix/login",
    worktreePath: null,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.history.import",
    commandId: CommandId.make("seed-source-history"),
    threadId: SOURCE_THREAD_ID,
    messages: [
      {
        messageId: MessageId.make("import:seed:0"),
        role: "user",
        text: "Fix the login bug",
        createdAt: "2026-09-28T09:01:00.000Z",
      },
      {
        messageId: MessageId.make("import:seed:1"),
        role: "assistant",
        text: "The session cookie is never refreshed. Patching auth.ts next.",
        createdAt: "2026-09-28T09:02:00.000Z",
      },
    ],
  });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make("source-limit"),
    threadId: SOURCE_THREAD_ID,
    session: {
      threadId: SOURCE_THREAD_ID,
      status: "error",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Claude usage limit reached. Send the message again once the limit resets.",
      updatedAt: "2026-09-28T09:03:00.000Z",
    },
    createdAt: "2026-09-28T09:03:00.000Z",
  });
});

it.layer(testLayer)("continueThreadInProvider", (it) => {
  it.effect("copies the conversation and starts a turn that carries the transcript", () =>
    Effect.gen(function* () {
      yield* seedSourceThread;
      yield* TestClock.setTime(Date.parse("2026-09-28T10:00:00.000Z"));
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfigModule.ServerConfig;
      const threadId = ThreadId.make("thread-continued");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

      const result = yield* continueThreadInProvider({
        sourceThreadId: SOURCE_THREAD_ID,
        threadId,
        modelSelection,
      });
      expect(result).toEqual({ threadId });

      const thread = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
      expect(thread.modelSelection).toEqual(modelSelection);
      expect(thread.branch).toBe("fix/login");
      expect(thread.title).toBe("Fix login");
      // Starting the turn wakes the thread the history import settled.
      expect(thread.settledAt).toBeNull();
      expect(thread.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Fix the login bug"],
        ["assistant", "The session cookie is never refreshed. Patching auth.ts next."],
        ["user", expect.stringContaining("Claude usage limit reached.")],
      ]);

      const handoff = thread.messages.at(-1)!;
      const attachment = handoff.attachments?.[0];
      expect(attachment).toMatchObject({ type: "file", mimeType: "text/markdown" });
      const transcriptPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment: attachment!,
      });
      const transcript = yield* fileSystem.readFileString(transcriptPath!);
      expect(transcript).toContain('<message role="user" time="2026-09-28T09:01:00.000Z">');
      expect(transcript).toContain("Patching auth.ts next.");
      expect(transcript).toContain("Provider: Claude (claude-opus-4-8)");

      // The source thread is left exactly as it was.
      const source = Option.getOrThrow(yield* snapshots.getThreadDetailById(SOURCE_THREAD_ID));
      expect(source.messages).toHaveLength(2);
    }),
  );

  it.effect("refuses to reuse a thread id and leaves that thread alone", () =>
    Effect.gen(function* () {
      // Receipts make the seed idempotent, so this test does not rely on the one above.
      yield* seedSourceThread;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

      const error = yield* Effect.flip(
        continueThreadInProvider({
          sourceThreadId: SOURCE_THREAD_ID,
          threadId: SOURCE_THREAD_ID,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        }),
      );

      expect(error._tag).toBe("ThreadContinueInProviderError");
      const source = Option.getOrThrow(yield* snapshots.getThreadDetailById(SOURCE_THREAD_ID));
      expect(source.deletedAt).toBeNull();
      expect(source.messages).toHaveLength(2);
    }),
  );

  it.effect("fails when the source thread does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        continueThreadInProvider({
          sourceThreadId: ThreadId.make("thread-missing"),
          threadId: ThreadId.make("thread-never-made"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        }),
      );

      expect(error.message).toBe("The thread to continue no longer exists.");
    }),
  );
});
