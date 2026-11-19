import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { readThreadShell } from "~/state/entities";
import { jiraAddComment } from "~/state/jira";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { issueCommentDraft } from "./jiraThreadText";

/** Each thread's title with the pull requests it opened, read from what the app already holds. */
export function commentDraftForThreads(threadRefs: ReadonlyArray<ScopedThreadRef>): string {
  return issueCommentDraft(
    threadRefs.flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null
        ? []
        : [{ title: shell.title, pullRequestUrls: shell.pullRequests.map((link) => link.url) }];
    }),
  );
}

export function JiraCommentForm({
  environmentId,
  issueKey,
  initialText = "",
  prefillThreads,
  autoFocus = false,
  onPosted,
}: {
  environmentId: EnvironmentId;
  issueKey: string;
  initialText?: string;
  /** The threads whose titles and pull requests "Add thread links" puts in the comment. */
  prefillThreads: ReadonlyArray<ScopedThreadRef>;
  autoFocus?: boolean;
  onPosted?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canComment = useAtomValue(jiraAddComment.permissionAtom(environmentId));
  const addComment = useAtomCommand(jiraAddComment, { reportFailure: false });

  const submit = async () => {
    const body = text.trim();
    if (body.length === 0 || pending) return;
    setPending(true);
    const result = await addComment({ environmentId, input: { key: issueKey, body } });
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not comment on ${issueKey}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    setText("");
    toastManager.add({ type: "success", title: `Commented on ${issueKey}` });
    onPosted?.();
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        autoFocus={autoFocus}
        rows={4}
        disabled={pending || !canComment}
        placeholder={
          canComment ? "Write a comment" : "This connection cannot comment on Jira issues."
        }
        aria-label={`Comment on ${issueKey}`}
      />
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost-muted"
          size="sm"
          disabled={pending || !canComment || prefillThreads.length === 0}
          onClick={() => {
            const draft = commentDraftForThreads(prefillThreads);
            if (draft.length === 0) return;
            setText((current) =>
              current.trim().length === 0 ? draft : `${current.trimEnd()}\n\n${draft}`,
            );
            textareaRef.current?.focus();
          }}
        >
          Add thread links
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={pending || !canComment || text.trim().length === 0}
        >
          {pending ? "Commenting..." : "Comment"}
        </Button>
      </div>
    </form>
  );
}
