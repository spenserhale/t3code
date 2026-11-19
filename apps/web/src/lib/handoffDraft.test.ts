import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { NewThreadHandler } from "../hooks/useHandleNewThread";
import { useThreadMachineHandoffStore } from "../threadMachineHandoffStore";
import { collectInlineContextIds } from "./composerContextReferences";
import { fileContextReference } from "./composerContextRecords";
import { openHandoffDraft } from "./handoffDraft";
import type { HandoffDraftRequest } from "./threadMachineHandoff";

const sourceEnvironment = EnvironmentId.make("environment-source");
const targetEnvironment = EnvironmentId.make("environment-target");
const project = scopeProjectRef(targetEnvironment, ProjectId.make("project-target"));
const draftId = DraftId.make("draft-new");
const threadId = ThreadId.make("thread-new");
const pending = {
  source: scopeThreadRef(sourceEnvironment, ThreadId.make("thread-source")),
  title: "Fix the flaky login test",
  sourceLabel: "Laptop",
  targetLabel: "Server",
};
const model = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };
const note = "Continuing the thread.\n\n";

const request: HandoffDraftRequest = {
  note,
  conversation: new File(['{"title":"t"}\n'], "thread-1234.jsonl", {
    type: "application/x-ndjson",
  }),
  worktree: { path: "/worktrees/handoff-fix-login", branch: "handoff/fix-login" },
  modelSelection: model,
};

type NewThreadOptions = NonNullable<Parameters<NewThreadHandler>[1]>;

/** Stands in for the new-thread handler: it opens a draft the way the real one does. */
function newThreadHandler(received: Array<NewThreadOptions | undefined>): NewThreadHandler {
  return async (projectRef, options) => {
    received.push(options);
    const drafts = useComposerDraftStore.getState();
    drafts.setLogicalProjectDraftThreadId("logical-project", projectRef, draftId, {
      threadId,
      branch: options?.branch ?? null,
      worktreePath: options?.worktreePath ?? null,
      envMode: options?.envMode ?? "local",
      startFromOrigin: options?.startFromOrigin ?? false,
    });
    if (options?.prompt !== undefined) drafts.setPrompt(draftId, options.prompt);
    return { draftId, threadId };
  };
}

describe("openHandoffDraft", () => {
  beforeEach(() => {
    useThreadMachineHandoffStore.setState({ byDraftId: {} });
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
  });

  it("opens a worktree draft on the pushed branch with the note, the model and the conversation", async () => {
    const received: Array<NewThreadOptions | undefined> = [];
    const opened = await openHandoffDraft({
      newThread: newThreadHandler(received),
      project,
      request,
      pending,
    });
    expect(opened).toBe(draftId);
    expect(received).toEqual([
      {
        branch: "handoff/fix-login",
        worktreePath: "/worktrees/handoff-fix-login",
        envMode: "worktree",
        prompt: note,
      },
    ]);

    const drafts = useComposerDraftStore.getState();
    expect(drafts.getDraftSession(draftId)).toMatchObject({
      environmentId: targetEnvironment,
      projectId: project.projectId,
      environmentSelection: "manual",
      envMode: "worktree",
      branch: "handoff/fix-login",
      worktreePath: "/worktrees/handoff-fix-login",
    });

    const draft = drafts.getComposerDraft(draftId)!;
    expect(draft.modelSelectionExplicit).toBe(true);
    expect(draft.modelSelectionByProvider[model.instanceId]).toEqual(model);
    expect(draft.files).toHaveLength(1);
    expect(draft.files[0]).toMatchObject({ name: "thread-1234.jsonl", file: request.conversation });
    expect(draft.prompt.startsWith(note)).toBe(true);
    expect(collectInlineContextIds(draft.prompt)).toEqual([
      fileContextReference(draft.files[0]!).contextId,
    ]);
  });

  it("remembers the source thread under the draft until its first message is sent", async () => {
    await openHandoffDraft({ newThread: newThreadHandler([]), project, request, pending });
    const entry = useThreadMachineHandoffStore.getState().byDraftId[draftId];
    expect(entry).toMatchObject({
      ...pending,
      target: scopeThreadRef(targetEnvironment, threadId),
      noteMarker: "Continuing the thread.",
      attachmentId: useComposerDraftStore.getState().getComposerDraft(draftId)?.files[0]?.id,
    });
    expect(Number.isNaN(Date.parse(entry?.createdAt ?? ""))).toBe(false);
  });

  it("leaves the workspace to the machine's defaults when no code was pushed", async () => {
    const received: Array<NewThreadOptions | undefined> = [];
    await openHandoffDraft({
      newThread: newThreadHandler(received),
      project,
      request: { ...request, worktree: null, modelSelection: null, conversation: null },
      pending,
    });
    expect(received).toEqual([{ prompt: note }]);
    const draft = useComposerDraftStore.getState().getComposerDraft(draftId)!;
    expect(draft.prompt).toBe(note);
    expect(draft.files).toEqual([]);
    expect(draft.modelSelectionExplicit).toBeUndefined();
  });

  it("reports a draft that could not be opened, and remembers nothing", async () => {
    await expect(
      openHandoffDraft({ newThread: async () => null, project, request, pending }),
    ).rejects.toThrow("Could not open a draft on Server.");
    expect(useThreadMachineHandoffStore.getState().byDraftId).toEqual({});
  });
});
