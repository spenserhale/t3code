import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderDriverKind,
  ThreadContinueInProviderError,
  type ChatFileAttachment,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadContinueInProviderInput,
  type ThreadContinueInProviderResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const TRANSCRIPT_FILE_NAME = "previous-thread-transcript.md";

type TranscriptMessage = Pick<OrchestrationMessage, "role" | "text" | "createdAt"> & {
  readonly attachmentLines: ReadonlyArray<string>;
};

/** Human label for the provider a thread ran on, e.g. "Claude (claude-opus-4-8)". */
export function describeThreadProvider(thread: OrchestrationThread): string {
  const driver = thread.session?.providerName ?? thread.modelSelection.instanceId;
  const name = PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(driver)] ?? driver;
  return `${name} (${thread.modelSelection.model})`;
}

// A message body that closes its own tag would end the block early for the reader.
const escapeMessageBody = (text: string) => text.replaceAll("</message>", "<\\/message>");

/**
 * Render the source conversation as one Markdown file. Each message sits in a
 * `<message role="...">` block so the next agent can tell the person's
 * requests from the previous agent's replies without guessing.
 */
export function buildContinuationTranscript(input: {
  readonly title: string;
  readonly provider: string;
  readonly workspace: string;
  readonly branch: string | null;
  readonly messages: ReadonlyArray<TranscriptMessage>;
}): string {
  const header = [
    `# Transcript of "${input.title}"`,
    "",
    `Provider: ${input.provider}`,
    `Workspace: ${input.workspace}`,
    ...(input.branch ? [`Branch: ${input.branch}`] : []),
    "",
    'Every message from the thread, oldest first. "user" is the person directing the work,',
    '"assistant" is the previous agent, and "system" is a notice from T3 Code.',
  ];
  const blocks = input.messages.map((message) =>
    [
      `<message role="${message.role}" time="${message.createdAt}">`,
      escapeMessageBody(message.text.trim()),
      ...message.attachmentLines,
      "</message>",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
  return `${[header.join("\n"), ...blocks].join("\n\n")}\n`;
}

/** The first message of the new thread: what happened, and what to do with the transcript. */
export function buildContinuationPrompt(input: {
  readonly title: string;
  readonly provider: string;
  readonly stopReason: string | null;
}): string {
  const stopped = input.stopReason ? `, which stopped with: "${input.stopReason}"` : "";
  return [
    `Continue the work from another thread, "${input.title}", that ran on ${input.provider}${stopped}.`,
    "",
    "The attached transcript holds every user and assistant message from that thread, oldest first, " +
      'each in a <message role="..."> block. Read it before doing anything else: all of it if it fits, ' +
      "otherwise the most recent messages first. You are in the " +
      "same workspace, so check the current state of the files instead of assuming the earlier edits " +
      "finished. Then carry on from where the previous agent stopped.",
  ].join("\n");
}

const failWith = (detail: string) => (cause: unknown) =>
  new ThreadContinueInProviderError({ detail, cause });

/**
 * Start a new thread on another provider that carries on from `sourceThreadId`.
 *
 * The new thread shows the source conversation through `thread.history.import`,
 * so the person sees the same messages in the same roles. The provider behind
 * it has no memory of them, so the first turn also attaches the whole
 * transcript as a file and asks the agent to read it.
 */
export const continueThreadInProvider = Effect.fn("continueThreadInProvider")(function* (
  input: ThreadContinueInProviderInput,
) {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const commandId = () => crypto.randomUUIDv4.pipe(Effect.map(CommandId.make));

  // Messages only: skip decoding every tool call's activity payload.
  const source = yield* snapshots
    .getThreadDetailById(input.sourceThreadId, { activityKinds: [] })
    .pipe(
      Effect.mapError(failWith("Could not read the thread to continue.")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ThreadContinueInProviderError({
                detail: "The thread to continue no longer exists.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  if (source.deletedAt !== null) {
    return yield* new ThreadContinueInProviderError({
      detail: "The thread to continue was deleted.",
    });
  }
  const project = yield* snapshots
    .getProjectShellById(source.projectId)
    .pipe(
      Effect.mapError(failWith("Could not read the thread's project.")),
      Effect.map(Option.getOrUndefined),
    );

  // Reasoning is the previous agent's private scratch space; the replies carry its conclusions.
  // A message with only an image still belongs in the transcript, as its file path.
  const sourceMessages = source.messages.filter(
    (message) =>
      message.role !== "reasoning" &&
      (message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0),
  );
  if (sourceMessages.length === 0) {
    return yield* new ThreadContinueInProviderError({
      detail: "The thread has no messages to continue from.",
    });
  }

  const provider = describeThreadProvider(source);
  const transcript = buildContinuationTranscript({
    title: source.title,
    provider,
    workspace: source.worktreePath ?? project?.workspaceRoot ?? "unknown",
    branch: source.branch,
    messages: sourceMessages.map((message) => ({
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      attachmentLines: (message.attachments ?? []).flatMap((attachment) => {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        return attachmentPath === null
          ? []
          : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`];
      }),
    })),
  });
  const transcriptBytes = new TextEncoder().encode(transcript);
  if (transcriptBytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return yield* new ThreadContinueInProviderError({
      detail: "The thread is too long to continue in another provider.",
    });
  }

  const attachmentId = createAttachmentId(input.threadId, "md");
  if (attachmentId === null) {
    return yield* new ThreadContinueInProviderError({
      detail: "Could not name the transcript file.",
    });
  }
  const attachment: ChatFileAttachment = {
    type: "file",
    id: attachmentId,
    name: TRANSCRIPT_FILE_NAME,
    mimeType: "text/markdown",
    sizeBytes: transcriptBytes.byteLength,
  };
  const attachmentPath = resolveAttachmentPath({
    attachmentsDir: serverConfig.attachmentsDir,
    attachment,
  });
  if (attachmentPath === null) {
    return yield* new ThreadContinueInProviderError({
      detail: "Could not place the transcript file.",
    });
  }

  let threadCreated = false;
  const program = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: yield* commandId(),
      threadId: input.threadId,
      projectId: source.projectId,
      title: source.title,
      modelSelection: input.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: source.branch,
      worktreePath: source.worktreePath,
      createdAt: now,
      historyImport: true,
    });
    threadCreated = true;
    // Written only once the thread exists: the file is named for it, so deleting the thread
    // removes the file too, even if the server dies before the cleanup below runs.
    yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
    yield* fileSystem.writeFile(attachmentPath, transcriptBytes);

    // History import takes only user and assistant turns; system notices live in the transcript.
    const visibleMessages = sourceMessages.filter(
      (message): message is OrchestrationMessage & { role: "user" | "assistant" } =>
        (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0,
    );
    if (visibleMessages.length > 0) {
      yield* engine.dispatch({
        type: "thread.history.import",
        commandId: yield* commandId(),
        threadId: input.threadId,
        // The `import:` prefix keeps these out of turn accounting and rewinds.
        messages: visibleMessages.map((message, index) => ({
          messageId: MessageId.make(
            `import:continued:${input.threadId}:${String(index).padStart(6, "0")}`,
          ),
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      });
    }

    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: yield* commandId(),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: buildContinuationPrompt({
          title: source.title,
          provider,
          stopReason: source.session?.lastError ?? null,
        }),
        attachments: [attachment],
      },
      modelSelection: input.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });

    return { threadId: input.threadId } satisfies ThreadContinueInProviderResult;
  });

  // Runs to the end even if the caller goes away, so a dropped socket cannot
  // leave a thread with copied history and no first turn.
  return yield* Effect.uninterruptible(program).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        // Leave nothing half-made behind: no empty thread, no orphaned file.
        if (threadCreated) {
          yield* commandId().pipe(
            Effect.flatMap((deleteCommandId) =>
              engine.dispatch({
                type: "thread.delete",
                commandId: deleteCommandId,
                threadId: input.threadId,
              }),
            ),
            Effect.ignore,
          );
        }
        yield* fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.ignore);
        return yield* new ThreadContinueInProviderError({
          detail:
            cause instanceof Error && cause.message.length > 0
              ? `Could not start the continuation thread: ${cause.message}`
              : "Could not start the continuation thread.",
          cause,
        });
      }),
    ),
  );
});
