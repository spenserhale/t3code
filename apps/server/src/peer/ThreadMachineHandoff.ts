import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadTranscript,
  OrchestratorMcpFailure,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ProjectId,
  type RepositoryIdentity,
  type ThreadContinueOnMachineInput,
  type ThreadContinueOnMachineResult,
  type ThreadId,
} from "@t3tools/contracts";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import {
  buildHandoffNote,
  collectHandoffBranchNames,
  explainHandoffGitFailure,
  handoffCommitMessage,
  HANDOFF_BRANCH_QUERY,
  isHandoffDefaultBranch,
  planHandoffCode,
  type HandoffCodePlan,
} from "@t3tools/shared/threadMachineHandoff";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { readAllRefPages } from "../git/readAllRefPages.ts";
import { parseRemoteFetchUrls } from "../git/remoteFetchUrls.ts";
import { parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";
import { repositoryBranchOf } from "../git/repositoryBranch.ts";
import { assertNotLinked } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { AttachmentToolkit } from "../mcp/toolkits/attachment/tools.ts";
import { WorktreeOpenBranchTool } from "../mcp/toolkits/machineHandoff/openBranchTool.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { readCaller, threadNotFound, unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { listRemoteProjects } from "./RemoteDelegation.ts";

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * Continues a thread on a linked machine for the agent that asks, the way the app's "Continue
 * on…" does for the user: the app sees both machines, so it drives them; here this server does,
 * through the link. Steps that only read come first, so a failure leaves the checkout alone.
 */
export class ThreadMachineHandoff extends Context.Service<
  ThreadMachineHandoff,
  {
    readonly continueOnMachine: (
      scope: Scope,
      input: ThreadContinueOnMachineInput,
    ) => Effect.Effect<ThreadContinueOnMachineResult, OrchestratorMcpFailure>;
  }
>()("t3/peer/ThreadMachineHandoff") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const gitFailed = (what: string) => (error: { readonly message: string }) =>
  failure("orchestration_error", `${what}: ${error.message}`);

interface Target {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Where the thread lands there: a project, or a scratch folder for a thread that has none. */
type TargetProject =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "scratch" };

const isTranscriptTooLarge = Schema.is(ThreadManagement.ThreadTranscriptTooLargeError);

const DEFAULT_MESSAGE = "Continue where the previous thread left off.";

/** The statuses the app counts as working; a thread in one is not handed off from outside. */
const WORKING_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

const waitingOnApproval = (shell: OrchestrationV2ThreadShell) =>
  shell.pendingRuntimeRequest !== null &&
  shell.pendingRuntimeRequest.kind !== "user_input" &&
  shell.pendingRuntimeRequest.kind !== "auth_refresh";

/** Where a project sits in its repository, to tell apart several projects of one repository. */
const pathInRepository = (project: {
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}): string | null => {
  const root = project.repositoryIdentity?.rootPath?.trim();
  if (!root) return null;
  const projectPath = normalizeProjectPathForComparison(project.workspaceRoot);
  const rootPath = normalizeProjectPathForComparison(root);
  if (projectPath.length === 0 || rootPath.length === 0) return null;
  if (projectPath === rootPath) return "";
  const prefix = `${rootPath}${rootPath.includes("\\") ? "\\" : "/"}`;
  return projectPath.startsWith(prefix)
    ? projectPath.slice(prefix.length).replaceAll("\\", "/")
    : null;
};

/** The conversation as the app attaches it: a header line, then one timeline item per line. */
const transcriptFile = (
  environmentId: EnvironmentId,
  transcript: OrchestrationV2ThreadTranscript,
) => {
  const id = toKindScopedComposerContextId(
    "thread",
    `${environmentId}:${transcript.threadId}:${DateTime.formatIso(transcript.updatedAt)}`,
  );
  const title = transcript.title.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 64) || "Thread";
  const text = [
    threadTranscriptHeader(environmentId, transcript),
    ...transcript.items.map((row) => `${JSON.stringify(row)}\n`),
  ].join("");
  return {
    name: `${title}-${id.slice(-16)}.jsonl`,
    mimeType: "application/x-ndjson",
    bytes: new TextEncoder().encode(text),
  };
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const statusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  // The transcript goes to the address that proved to be the peer, and nowhere a redirect leads.
  const peerHttp = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
  const inFlight = new Set<ThreadId>();

  const newCommandId = crypto.randomUUIDv4().pipe(
    Effect.orDie,
    Effect.map((uuid) => CommandId.make(`mcp:${uuid}`)),
  );

  const callerOf = (scope: Scope) =>
    readCaller().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /** The link, usable now: the beta is on, it names another machine, and that machine answers. */
  const requireTarget = Effect.fn("ThreadMachineHandoff.requireTarget")(function* (
    environmentId: EnvironmentId,
    here: EnvironmentId,
  ) {
    if (!(yield* links.enabled)) return yield* PeerForwarding.linkedEnvironmentsOff;
    if (environmentId === here) {
      return yield* failure(
        "invalid_request",
        "That is the machine this thread is on. Pass another linked machine's environmentId; t3_environment_links lists them.",
      );
    }
    return yield* links
      .resolve(environmentId)
      .pipe(
        Effect.mapError((error) =>
          error.reason === "unknown_link"
            ? failure(
                "invalid_request",
                `${environmentId} is not a linked environment, so a thread cannot continue there. If the user means another machine, call t3_environment_link with a hint from their words; t3_environment_links lists the linked ones.`,
              )
            : PeerMcpClient.fromLinkError(error),
        ),
      );
  });

  const readSource = Effect.fn("ThreadMachineHandoff.readSource")(function* (
    scope: Scope,
    requested: ThreadId | undefined,
  ) {
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* failure(
        "target_required",
        "Pass threadId: this MCP client is not running inside a T3 thread.",
      );
    }
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(threads, threadId, "The thread was not found.");
    }
    if (shell.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        "The thread is archived. Unarchive it before continuing it on another machine.",
      );
    }
    // The caller's own thread is working: it is the agent making this call.
    const own = scope.thread?.threadId === threadId;
    if (!own && WORKING_STATUSES.has(shell.status)) {
      return yield* failure(
        "invalid_request",
        "That thread is still working. Wait for it to finish or stop it first.",
      );
    }
    if (!own && waitingOnApproval(shell)) {
      return yield* failure(
        "invalid_request",
        "That thread is waiting on an approval. Answer it first.",
      );
    }
    const project = yield* projects.getById(shell.projectId).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("invalid_request", "The thread's project was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const scratch = yield* folders.isScratchProject(project.id);
    const identity = scratch ? null : yield* repositoryIdentities.resolve(project.workspaceRoot);
    return {
      threadId,
      shell,
      own,
      project,
      scratch,
      identity,
      carriesCode: Boolean(identity?.locator.remoteUrl),
      cwd: shell.worktreePath ?? project.workspaceRoot,
    };
  });
  type Source = Effect.Success<ReturnType<typeof readSource>>;

  /** What carrying the checkout's work takes. A detached head stops here, before anything is done. */
  const planCode = Effect.fn("ThreadMachineHandoff.planCode")(function* (
    source: Source,
    label: string,
  ) {
    if (!source.carriesCode) {
      return {
        kind: "none",
        reason: source.scratch ? "scratch" : "no-remote",
      } satisfies HandoffCodePlan;
    }
    const { cwd } = source;
    const status = yield* statusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.mapError(gitFailed("Could not read the repository's status")));
    // The server lists the current branch first and the default second, so a few refs show
    // whether the repository names its default.
    const leading = yield* gitWorkflow
      .listRefs({ cwd, includeMatchingRemoteRefs: true, limit: 5 })
      .pipe(Effect.mapError(gitFailed("Could not read the repository's branches")));
    const checkout = { ...status, defaultBranchKnown: leading.refs.some((ref) => ref.isDefault) };
    let existingBranchNames: ReadonlyArray<string> = [];
    if (isHandoffDefaultBranch(checkout)) {
      const refs = yield* readAllRefPages((cursor) =>
        gitWorkflow
          .listRefs({
            cwd,
            query: HANDOFF_BRANCH_QUERY,
            includeMatchingRemoteRefs: true,
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          })
          .pipe(Effect.mapError(gitFailed("Could not read the repository's branches"))),
      );
      if (refs === null) {
        return yield* failure(
          "orchestration_error",
          "This repository has too many branches to check them all.",
        );
      }
      existingBranchNames = collectHandoffBranchNames(refs);
    }
    const planned = planHandoffCode({
      title: source.shell.title,
      machineLabel: label,
      git: checkout,
      existingBranchNames,
    });
    return "kind" in planned ? yield* failure("invalid_request", planned.message) : planned.code;
  });

  /** The project on the other machine: the one named, the one with this repository, or a scratch folder. */
  const findTargetProject = Effect.fn("ThreadMachineHandoff.findTargetProject")(function* (
    scope: Scope,
    target: Target,
    source: Source,
    requested: ProjectId | undefined,
  ) {
    const { environmentId, label } = target;
    if (requested !== undefined) {
      yield* forwarding.call(scope, ProjectToolkit.tools.t3_project_read, environmentId, {
        projectId: requested,
      });
      return { kind: "project", projectId: requested } as const;
    }
    if (source.scratch) return { kind: "scratch" } as const;
    const { identity } = source;
    if (identity === null) {
      return yield* failure(
        "target_required",
        `This thread's project has no repository to match on ${label}. Pass projectId: t3_project_list with environmentId ${environmentId} lists its projects.`,
      );
    }
    // The repository a push from the project goes to: a fork's own origin, else its only remote.
    const key = identity.origin?.canonicalKey ?? identity.canonicalKey;
    const sourcePath = pathInRepository({
      workspaceRoot: source.project.workspaceRoot,
      repositoryIdentity: identity,
    });
    const matches = (yield* listRemoteProjects(forwarding, scope, environmentId)).filter(
      (candidate) => {
        const found = candidate.repositoryIdentity;
        if (candidate.archivedAt != null || found == null) return false;
        if (found.canonicalKey !== key && found.origin?.canonicalKey !== key) return false;
        const path = pathInRepository(candidate);
        return sourcePath === null || path === null || path === sourcePath;
      },
    );
    if (matches.length === 1) return { kind: "project", projectId: matches[0]!.id } as const;
    return yield* failure(
      "invalid_request",
      matches.length === 0
        ? `No project on ${label} has this repository (${key}). Pass projectId; t3_project_list with environmentId ${environmentId} lists them. To bring the repository there, use t3_project_clone and then t3_project_create with that environmentId.`
        : `Several projects on ${label} have this repository: ${matches.map((match) => `${match.title} (${match.id})`).join(", ")}. Pass projectId.`,
    );
  });

  /** The launch would refuse a model the machine lacks, but only after the work was pushed. */
  const requireModel = Effect.fn("ThreadMachineHandoff.requireModel")(function* (
    scope: Scope,
    target: Target,
    selection: ModelSelection,
  ) {
    const capabilities = yield* forwarding.call(
      scope,
      OrchestratorToolkit.tools.orchestrator_capabilities,
      target.environmentId,
      { search: selection.model },
    );
    const provider = capabilities.providers.find(
      (candidate) => candidate.providerInstanceId === selection.instanceId,
    );
    const hint = `Pass modelSelection from orchestrator_capabilities with environmentId ${target.environmentId}.`;
    if (provider === undefined) {
      return yield* failure(
        "provider_unavailable",
        `${target.label} has no provider ${selection.instanceId}. ${hint}`,
      );
    }
    if (!provider.models.some((model) => model.id === selection.model)) {
      return yield* failure(
        "model_unavailable",
        `${target.label} has ${selection.instanceId}, but not the model ${selection.model}. ${hint}`,
      );
    }
  });

  const readTranscript = Effect.fn("ThreadMachineHandoff.readTranscript")(function* (
    threadId: ThreadId,
  ) {
    const identity = ServerEnvironment.ServerEnvironmentIdentity.of({
      getEnvironmentId: environment.getEnvironmentId,
    });
    const transcript = yield* threads.getThreadTranscript(threadId).pipe(
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, identity),
      Effect.mapError((error) =>
        isTranscriptTooLarge(error)
          ? failure("invalid_request", "This thread is too large to attach as a file.")
          : unavailable(),
      ),
    );
    const file = transcriptFile(yield* environment.getEnvironmentId, transcript);
    if (file.bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      return yield* failure("invalid_request", "This thread is too large to attach as a file.");
    }
    return file;
  });

  /** Puts the file where the link's other side can claim it: a pending upload, then its bytes. */
  const uploadFile = Effect.fn("ThreadMachineHandoff.uploadFile")(function* (
    scope: Scope,
    resolved: PeerLinks.ResolvedPeerLink,
    file: Effect.Success<ReturnType<typeof readTranscript>>,
  ) {
    const { environmentId, label } = resolved.link;
    const sizeBytes = file.bytes.byteLength;
    const prepared = yield* forwarding.call(
      scope,
      AttachmentToolkit.tools.t3_attachment_prepare_upload,
      environmentId,
      { upload: { type: "file", name: file.name, mimeType: file.mimeType, sizeBytes } },
    );
    // The URL is signed by the other machine, so no credential goes with the bytes.
    const response = yield* peerHttp
      .execute(
        HttpClientRequest.post(`${resolved.url}${prepared.relativeUrl}`).pipe(
          HttpClientRequest.setBody(HttpBody.uint8Array(file.bytes, file.mimeType)),
        ),
      )
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", `The conversation could not be uploaded to ${label}.`),
        ),
      );
    if (response.status !== 204) {
      // Its reason is a short line of plain text, such as "Body was 3 bytes, expected 5."
      const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* failure(
        "orchestration_error",
        `${label} refused the conversation upload (HTTP ${response.status}${
          detail.trim() === "" ? "" : `: ${detail.trim().slice(0, 200)}`
        }).`,
      );
    }
    return {
      type: "file" as const,
      id: prepared.attachmentId,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes,
    };
  });
  type Attachment = Effect.Success<ReturnType<typeof uploadFile>>;

  /**
   * Commits whatever the checkout has and pushes its branch, after moving off the default branch
   * when it is on one. The commit step refuses unless the checkout is still on that branch.
   */
  const pushWork = Effect.fn("ThreadMachineHandoff.pushWork")(function* (
    source: Source,
    code: Extract<HandoffCodePlan, { readonly kind: "carry" }>,
    label: string,
  ) {
    const { cwd, threadId } = source;
    let branch = code.branch;
    if (code.createBranch) {
      const created = yield* gitWorkflow
        .createRef({ cwd, refName: code.branch, switchRef: true })
        .pipe(Effect.mapError(gitFailed(`Could not create the branch ${code.branch}`)));
      branch = created.refName;
      // The checkout moved to the new branch; the thread follows it. Best effort: the work is safe either way.
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: yield* newCommandId,
          threadId,
          branch,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    const actionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    let committed = false;
    let commitWaitsToPush = false;
    const result = yield* gitWorkflow
      .runStackedAction(
        {
          actionId,
          cwd,
          action: "commit_push",
          commitMessage: handoffCommitMessage(label),
          threadId,
        },
        {
          actionId,
          // The commit step checks it under its checkout lease; a check made here could be stale by then.
          expectedBranch: branch,
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                if (event.kind !== "phase_started") return;
                if (event.phase === "commit") committed = true;
                if (event.phase === "push") commitWaitsToPush = committed;
              }),
          },
        },
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Could not push ${branch}: ${explainHandoffGitFailure(error.message)}${
              code.createBranch ? ` The checkout in ${cwd} is now on ${branch}.` : ""
            }${commitWaitsToPush ? " Its WIP commit was not pushed." : ""}`,
          ),
        ),
      );
    const upstream = result.push.upstreamBranch;
    if (upstream === undefined) {
      return yield* failure(
        "orchestration_error",
        "The push did not say which remote branch it updated.",
      );
    }
    const listed = yield* git
      .execute({ operation: "ThreadMachineHandoff.listRemotes", cwd, args: ["remote", "-v"] })
      .pipe(Effect.mapError(gitFailed("Could not list the remotes")));
    const urls = parseRemoteFetchUrls(listed.stdout);
    const repositories = new Map(
      [...urls].map(([name, url]) => [name, sourceControlDefinitions.repositoryKeyFromRemote(url)]),
    );
    const pushedTo = parseRemoteRefWithRemoteNames(
      upstream,
      [...urls.keys()].toSorted((left, right) => right.length - left.length),
    );
    if (pushedTo === null) {
      return yield* failure(
        "orchestration_error",
        `The push reported the remote branch "${upstream}", which is not usable.`,
      );
    }
    const head = yield* git
      .resolveCommit({ cwd, revision: "HEAD" })
      .pipe(Effect.mapError(gitFailed("Could not read the pushed commit")));
    yield* statusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
    const repositoryKey = repositories.get(pushedTo.remoteName)!;
    return {
      branch: pushedTo.branchName,
      remote: pushedTo.remoteName,
      repositoryKey,
      // What pull requests compare with, by repository: its remote has another name on the target.
      base:
        code.comparisonBase === null
          ? null
          : repositoryBranchOf(code.comparisonBase, repositories, repositoryKey),
      commit: head.commitSha,
      wipCommit: result.commit.status === "created",
    };
  });
  type Pushed = Effect.Success<ReturnType<typeof pushWork>>;

  /** Has the other machine put the pushed branch on a worktree that holds the pushed commit. */
  const openOnTarget = Effect.fn("ThreadMachineHandoff.openOnTarget")(function* (
    scope: Scope,
    target: Target,
    projectId: ProjectId,
    pushed: Pushed,
  ) {
    return yield* forwarding.call(scope, WorktreeOpenBranchTool, target.environmentId, {
      projectId,
      branch: pushed.branch,
      repositoryKey: pushed.repositoryKey,
      ...(pushed.base === null
        ? {}
        : {
            baseBranch: pushed.base.branch,
            ...(pushed.base.repositoryKey === pushed.repositoryKey
              ? {}
              : { baseRepositoryKey: pushed.base.repositoryKey }),
          }),
      expectCommit: pushed.commit,
    });
  });

  const launchThere = Effect.fn("ThreadMachineHandoff.launchThere")(function* (
    scope: Scope,
    target: Target,
    launch: {
      readonly project: TargetProject;
      readonly title: string;
      readonly modelSelection: ModelSelection;
      readonly worktree: { readonly worktreePath: string; readonly branch: string } | null;
      readonly message: string;
      readonly attachment: Attachment;
      readonly clientRequestId: string | undefined;
    },
  ) {
    return yield* forwarding.call(
      scope,
      ProjectToolkit.tools.t3_thread_launch,
      target.environmentId,
      {
        ...(launch.project.kind === "scratch"
          ? { scratch: true }
          : { projectId: launch.project.projectId }),
        title: launch.title,
        modelSelection: launch.modelSelection,
        ...(launch.worktree === null
          ? {}
          : { workspaceStrategy: { type: "existing_worktree" as const, ...launch.worktree } }),
        message: launch.message,
        attachments: [launch.attachment],
        ...(launch.clientRequestId === undefined
          ? {}
          : { clientRequestId: launch.clientRequestId }),
      },
      { attachmentsOnPeer: true },
    );
  });

  /** Settled as t3_thread_organize does: the caller's own thread when its turn ends. */
  const settleSource = Effect.fn("ThreadMachineHandoff.settleSource")(function* (source: Source) {
    return yield* threads
      .settleThread({
        threadId: source.threadId,
        commandId: yield* newCommandId,
        byOwnAgent: source.own,
      })
      .pipe(
        Effect.map((settled): "now" | "at_turn_end" =>
          "settlesWhenTurnEnds" in settled ? "at_turn_end" : "now",
        ),
        Effect.catch((error) =>
          Effect.logWarning("thread hand-off could not settle its source", {
            threadId: source.threadId,
            error,
          }).pipe(Effect.as("failed" as const)),
        ),
      );
  });

  const handOff = Effect.fn("ThreadMachineHandoff.handOff")(function* (
    scope: Scope,
    input: ThreadContinueOnMachineInput,
    resolved: PeerLinks.ResolvedPeerLink,
    target: Target,
    source: Source,
  ) {
    if (source.carriesCode && !scope.capabilities.has("worktree")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant worktree capabilities, which committing and pushing need.",
      );
    }
    // Reads first, here and there, so a failure up to the upload leaves the checkout alone.
    const code = yield* planCode(source, target.label);
    const project = yield* findTargetProject(scope, target, source, input.projectId);
    const modelSelection = input.modelSelection ?? source.shell.modelSelection;
    yield* requireModel(scope, target, modelSelection);
    const attachment = yield* uploadFile(scope, resolved, yield* readTranscript(source.threadId));

    const pushed = code.kind === "carry" ? yield* pushWork(source, code, target.label) : null;
    const pushedNote =
      pushed === null
        ? ""
        : ` The work is committed and pushed to ${pushed.remote}/${pushed.branch} (${pushed.commit.slice(0, 7)}) and this thread was not settled.`;
    // A scratch project carries no code, so a push means the target is a project.
    const opened =
      pushed === null || project.kind === "scratch"
        ? null
        : yield* openOnTarget(scope, target, project.projectId, pushed).pipe(
            Effect.mapError((error) =>
              error.message.includes("'t3_worktree_open_branch' not found")
                ? failure(
                    "capability_denied",
                    `${target.label} runs a T3 Code version that does not have t3_worktree_open_branch, so it cannot open the branch. Both machines need a version that has it.${pushedNote}`,
                  )
                : failure(error.code, `${error.message}${pushedNote}`),
            ),
          );

    const note = buildHandoffNote({
      title: source.shell.title,
      sourceLabel: (yield* environment.getDescriptor).label,
      // The note names a WIP commit only if this call made one.
      code: code.kind === "carry" && pushed?.wipCommit === false ? { ...code, commit: null } : code,
      remoteRef: opened === null ? null : `${opened.remote}/${opened.branch}`,
      threadLink: formatThreadLink({
        environmentId: scope.environmentId,
        threadId: source.threadId,
      }),
      transcriptAttached: true,
    });
    const launched = yield* launchThere(scope, target, {
      project,
      title: source.shell.title.trim() || "Untitled thread",
      modelSelection,
      worktree:
        opened === null ? null : { worktreePath: opened.worktreePath, branch: opened.branch },
      message: `${note}${input.message ?? DEFAULT_MESSAGE}`,
      attachment,
      clientRequestId: input.clientRequestId,
    }).pipe(
      Effect.mapError((error) =>
        failure(
          error.code,
          `${error.message}${pushedNote}${
            opened === null
              ? ""
              : ` The worktree ${opened.worktreePath} on ${target.label} was kept: retry with the same clientRequestId to reuse it.`
          }`,
        ),
      ),
    );

    return {
      environmentId: target.environmentId,
      threadId: launched.threadId,
      link:
        launched.link ??
        formatThreadLink({ environmentId: target.environmentId, threadId: launched.threadId }),
      projectId: launched.projectId,
      branch: opened?.branch ?? null,
      pushedCommit: pushed?.commit ?? null,
      worktreePath: opened?.worktreePath ?? null,
      sourceSettles: yield* settleSource(source),
    } satisfies ThreadContinueOnMachineResult;
  });

  const continueOnMachine: ThreadMachineHandoff["Service"]["continueOnMachine"] = Effect.fn(
    "ThreadMachineHandoff.continueOnMachine",
  )(function* (scope, input) {
    // Work a link started never uses this environment's links.
    yield* assertNotLinked(yield* callerOf(scope), "continue a thread on another machine");
    const resolved = yield* requireTarget(input.environmentId, scope.environmentId);
    const target = { environmentId: input.environmentId, label: resolved.link.label };
    const source = yield* readSource(scope, input.threadId);
    if (inFlight.has(source.threadId)) {
      return yield* failure("invalid_request", "A hand-off of this thread is already running.");
    }
    inFlight.add(source.threadId);
    return yield* handOff(scope, input, resolved, target, source).pipe(
      Effect.ensuring(Effect.sync(() => inFlight.delete(source.threadId))),
    );
  });

  return ThreadMachineHandoff.of({ continueOnMachine });
});

export const layer = Layer.effect(ThreadMachineHandoff, make);
