import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JiraIssueDetail,
  JiraIssueSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { jiraIssueQuery, jiraTransition, jiraTransitionsQuery } from "~/state/jira";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { JiraCommentForm } from "./JiraCommentForm";
import { JiraLinkedThreads } from "./JiraLinkedThreads";
import { JiraLinkThreadDialog } from "./JiraLinkThreadDialog";
import { JiraStartThreadDialog } from "./JiraStartThreadDialog";
import { JiraIssueTypeIcon, JiraStatusBadge } from "./jiraPresentation";

function JiraTransitionMenu({
  environmentId,
  issue,
}: {
  environmentId: EnvironmentId;
  issue: Pick<JiraIssueSummary, "key" | "status">;
}) {
  const [open, setOpen] = useState(false);
  const transitions = useEnvironmentQuery(
    open ? jiraTransitionsQuery({ environmentId, input: { key: issue.key } }) : null,
  );
  const canTransition = useAtomValue(jiraTransition.permissionAtom(environmentId));
  const runTransition = useAtomCommand(jiraTransition, { reportFailure: false });

  const move = async (transitionId: string, statusName: string) => {
    const result = await runTransition({
      environmentId,
      input: { key: issue.key, transitionId },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not move ${issue.key}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    toastManager.add({ type: "success", title: `Moved ${issue.key} to ${statusName}` });
  };

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        disabled={!canTransition}
        aria-label={`Status of ${issue.key}: ${issue.status.name}. Move it.`}
        render={<Button variant="outline" size="sm" />}
      >
        <JiraStatusBadge status={issue.status} />
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start">
        {transitions.data === null ? (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">
            {transitions.error ?? "Loading moves..."}
          </p>
        ) : transitions.data.transitions.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">
            Jira offers no moves from here.
          </p>
        ) : (
          transitions.data.transitions.map((transition) => (
            <MenuItem
              key={transition.id}
              onClick={() => void move(transition.id, transition.to.name)}
            >
              <span className="min-w-0 truncate">{transition.to.name}</span>
              {transition.name.toLowerCase() === transition.to.name.toLowerCase() ? null : (
                <span className="ml-auto truncate text-muted-foreground text-xs">
                  {transition.name}
                </span>
              )}
            </MenuItem>
          ))
        )}
      </MenuPopup>
    </Menu>
  );
}

function Facts({ issue }: { issue: JiraIssueDetail }) {
  const facts: ReadonlyArray<readonly [string, string | null]> = [
    ["Assignee", issue.assignee?.displayName ?? "Unassigned"],
    ["Reporter", issue.reporter?.displayName ?? null],
    ["Priority", issue.priority],
    ["Project", `${issue.projectName} (${issue.projectKey})`],
  ];
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Type</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          <JiraIssueTypeIcon
            issueType={issue.issueType}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate">{issue.issueType}</span>
        </dd>
        {facts.map(([label, value]) =>
          value === null ? null : (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate">{value}</dd>
            </div>
          ),
        )}
        <dt className="text-muted-foreground">Updated</dt>
        <dd>
          <RelativeTime timestamp={issue.updatedAt} />
        </dd>
      </dl>
      {issue.labels.length === 0 ? null : (
        <p className="flex flex-wrap gap-1.5 text-muted-foreground text-xs">
          {issue.labels.map((label) => (
            <span key={label} className="rounded-sm bg-muted px-1.5 py-0.5">
              {label}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      {children}
    </section>
  );
}

function IssueBody({
  environmentId,
  issue,
  linked,
}: {
  environmentId: EnvironmentId;
  issue: JiraIssueDetail;
  linked: ReadonlyArray<ScopedThreadRef>;
}) {
  const [starting, setStarting] = useState(false);
  const [linking, setLinking] = useState(false);
  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-3">
        <h2 className="text-balance font-medium text-lg leading-snug">{issue.summary}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <JiraTransitionMenu environmentId={environmentId} issue={issue} />
          <Button size="sm" onClick={() => setStarting(true)}>
            <PlayIcon aria-hidden />
            Start thread
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
            <LinkIcon aria-hidden />
            Link thread
          </Button>
        </div>
      </div>
      <Facts issue={issue} />
      <Section title={`Linked threads (${linked.length})`}>
        <JiraLinkedThreads threadRefs={linked} issueKey={issue.key} />
      </Section>
      <Section title="Description">
        {issue.descriptionMarkdown.trim().length === 0 ? (
          <p className="text-muted-foreground text-sm">No description.</p>
        ) : (
          <div className="text-sm">
            <ChatMarkdown text={issue.descriptionMarkdown} cwd={undefined} />
          </div>
        )}
      </Section>
      <Section title={`Comments (${issue.commentCount})`}>
        {issue.commentCount > issue.comments.length ? (
          <p className="text-muted-foreground text-xs">
            Showing the latest {issue.comments.length}. Older ones are on the issue.
          </p>
        ) : null}
        <ul className="flex flex-col gap-4">
          {issue.comments.map((comment) => (
            <li key={comment.id} className="flex flex-col gap-1">
              <p className="text-muted-foreground text-xs">
                <span className="font-medium text-foreground">
                  {comment.author?.displayName ?? "Someone"}
                </span>{" "}
                <RelativeTime timestamp={comment.createdAt} />
              </p>
              <div className="text-sm">
                <ChatMarkdown text={comment.bodyMarkdown} cwd={undefined} />
              </div>
            </li>
          ))}
        </ul>
        <JiraCommentForm
          environmentId={environmentId}
          issueKey={issue.key}
          prefillThreads={linked}
        />
      </Section>
      <JiraStartThreadDialog
        open={starting}
        onOpenChange={setStarting}
        issue={issue}
        jiraEnvironmentId={environmentId}
      />
      <JiraLinkThreadDialog
        open={linking}
        onOpenChange={setLinking}
        issueKey={issue.key}
        linked={linked}
      />
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4" aria-busy>
      <Skeleton shape="pill" className="h-6 w-3/4" />
      <Skeleton shape="pill" className="h-8 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function JiraIssuePanel({
  environmentId,
  issueKey,
  listed,
  linked,
  onClose,
}: {
  environmentId: EnvironmentId;
  issueKey: string;
  listed: JiraIssueSummary | undefined;
  linked: ReadonlyArray<ScopedThreadRef>;
  onClose: () => void;
}) {
  const detail = useEnvironmentQuery(jiraIssueQuery({ environmentId, input: { key: issueKey } }));
  const url = detail.data?.url ?? listed?.url ?? null;
  return (
    <aside
      {...workspaceAreaProps("jira-issue", 2, `Issue ${issueKey}`)}
      className="flex min-h-0 w-full min-w-0 flex-col border-l bg-background md:w-[min(46rem,52%)] md:shrink-0"
    >
      <header
        className={cn(
          "flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1.5 border-b pl-4 pr-3 wco:pr-(--workspace-native-controls-inset)",
          isElectron && "drag-region",
        )}
      >
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="Back to the list"
          className="md:hidden"
          onClick={onClose}
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{issueKey}</span>
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="Copy issue key"
          onClick={() =>
            void writeTextToClipboard(issueKey, "issue key").then((copied) => {
              if (copied) toastManager.add({ type: "success", title: "Issue key copied" });
            })
          }
        >
          <CopyIcon aria-hidden />
        </Button>
        {url === null ? null : (
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Open in Jira"
            render={<a href={url} target="_blank" rel="noreferrer noopener" />}
          >
            <ExternalLinkIcon aria-hidden />
          </Button>
        )}
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="Close issue"
          className="max-md:hidden"
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail.data !== null ? (
          <IssueBody environmentId={environmentId} issue={detail.data} linked={linked} />
        ) : detail.error !== null ? (
          <div className="flex flex-col items-start gap-3 p-4">
            <p className="text-sm">{detail.error}</p>
            <Button size="sm" variant="outline" onClick={detail.refresh}>
              Try again
            </Button>
          </div>
        ) : (
          <PanelSkeleton />
        )}
      </div>
    </aside>
  );
}
