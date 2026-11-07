import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { JiraCommentForm, commentDraftForThreads } from "./JiraCommentForm";

interface JiraCommentTarget {
  readonly environmentId: EnvironmentId;
  readonly issueKey: string;
  readonly threadRef: ScopedThreadRef;
}

// Hosted away from the thread row it opens from, so clicks in the dialog do not reach the row.
const jiraCommentTargetAtom = Atom.make<JiraCommentTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("jira:comment-dialog-target"),
);

export function openJiraCommentDialog(target: JiraCommentTarget): void {
  appAtomRegistry.set(jiraCommentTargetAtom, target);
}

/** Comments back on an issue from a linked thread, starting from the thread's title and pull requests. */
export function JiraCommentDialogHost() {
  const target = useAtomValue(jiraCommentTargetAtom);
  const close = () => appAtomRegistry.set(jiraCommentTargetAtom, null);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-xl">
        {target === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>Comment on {target.issueKey}</DialogTitle>
              <DialogDescription>
                Edit the text before it goes to Jira. Web addresses become links.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <JiraCommentForm
                environmentId={target.environmentId}
                issueKey={target.issueKey}
                initialText={commentDraftForThreads([target.threadRef])}
                prefillThreads={[target.threadRef]}
                autoFocus
                onPosted={close}
              />
            </DialogPanel>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
