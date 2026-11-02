import type { JiraIssueSummary, ScopedThreadRef } from "@t3tools/contracts";
import { LinkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { JiraIssueGroup } from "./jiraIssueGroups";
import { JiraIssueTypeIcon, JiraStatusBadge } from "./jiraPresentation";

const JiraIssueRow = memo(function JiraIssueRow({
  issue,
  selected,
  linkedThreads,
  onSelect,
}: {
  issue: JiraIssueSummary;
  selected: boolean;
  linkedThreads: number;
  onSelect: (key: string) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(issue.key)}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors [content-visibility:auto] [contain-intrinsic-block-size:56.5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <Tooltip>
        <TooltipTrigger render={<span className="mt-0.5 inline-flex shrink-0" />}>
          <JiraIssueTypeIcon issueType={issue.issueType} className="size-4 text-muted-foreground" />
          <span className="sr-only">{issue.issueType}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{issue.issueType}</TooltipPopup>
      </Tooltip>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {issue.key}
          </span>
          <span className="min-w-0 truncate text-sm">{issue.summary}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <JiraStatusBadge status={issue.status} />
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
          {issue.priority === null ? null : <span className="shrink-0">{issue.priority}</span>}
          <span className="min-w-0 truncate">
            {issue.assignee === null ? "Unassigned" : issue.assignee.displayName}
          </span>
          <span className="truncate">{issue.projectKey}</span>
          {linkedThreads > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={<span className="inline-flex shrink-0 items-center gap-0.5" />}
              >
                <LinkIcon aria-hidden className="size-3" />
                <span>{linkedThreads}</span>
                <span className="sr-only">
                  {linkedThreads === 1 ? "linked thread" : "linked threads"}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">
                {linkedThreads === 1 ? "1 linked thread" : `${linkedThreads} linked threads`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
            <RelativeTime timestamp={issue.updatedAt} />
          </span>
        </span>
      </span>
    </button>
  );
});

function JiraGroupHeader({ group }: { group: JiraIssueGroup }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
      <h2 className="shrink-0">{group.label}</h2>
      <span className="shrink-0 tabular-nums text-muted-foreground/50">{group.issues.length}</span>
      <Separator className="min-w-2 flex-1" />
    </div>
  );
}

export function JiraIssueList({
  groups,
  selectedKey,
  linkedThreads,
  onSelect,
}: {
  groups: ReadonlyArray<JiraIssueGroup>;
  selectedKey: string | undefined;
  linkedThreads: ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>>;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.category} className="space-y-0.5">
          <JiraGroupHeader group={group} />
          {group.issues.map((issue) => (
            <JiraIssueRow
              key={issue.key}
              issue={issue}
              selected={issue.key === selectedKey}
              linkedThreads={linkedThreads.get(issue.key)?.length ?? 0}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
