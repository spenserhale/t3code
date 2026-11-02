import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { SearchXIcon, SquareKanbanIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { workspaceAreaProps } from "~/lib/workspaceFocus";
import { useEnvironments } from "~/state/environments";
import {
  jiraConfiguredEnvironmentIdsAtom,
  jiraLinkedThreadsAtom,
  jiraProjectsQuery,
  jiraSearchViewAtom,
  refreshJira,
  useJiraEnvironmentId,
} from "~/state/jira";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { JiraFilterBar, type JiraFilters } from "./JiraFilterBar";
import { JiraIssueList } from "./JiraIssueList";
import { JiraIssuePanel } from "./JiraIssuePanel";
import { groupIssuesByStatus } from "./jiraIssueGroups";
import {
  applyJiraSearchPatch,
  jiraSearchInput,
  type JiraSearch,
  type JiraSearchPatch,
} from "./jiraRouteSearch";

function JiraNotSetUp() {
  const navigate = useNavigate();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background">
        <Empty>
          <EmptyMedia variant="icon">
            <SquareKanbanIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>Jira is not set up</EmptyTitle>
            <EmptyDescription>
              Add your site, email and an API token under Settings, Source control.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/source-control" })}
          >
            Open settings
          </Button>
        </Empty>
      </div>
    </SidebarInset>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy>
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} className="h-14 w-full" />
      ))}
    </div>
  );
}

function JiraWorkspace({
  environmentId,
  search,
  onSearch,
}: {
  environmentId: EnvironmentId;
  search: JiraSearch;
  onSearch: (patch: JiraSearchPatch) => void;
}) {
  const { environments } = useEnvironments();
  const configured = useAtomValue(jiraConfiguredEnvironmentIdsAtom);
  const linked = useAtomValue(jiraLinkedThreadsAtom);
  const projects = useEnvironmentQuery(jiraProjectsQuery({ environmentId, input: {} }));
  const input = jiraSearchInput(search);
  const inputKey = JSON.stringify(input);
  const [paging, setPaging] = useState({ inputKey, pages: 1 });
  const pages = paging.inputKey === inputKey ? paging.pages : 1;
  const view = useAtomValue(jiraSearchViewAtom(JSON.stringify({ environmentId, input, pages })));
  const groups = groupIssuesByStatus(view.issues);
  const selected = search.issue;

  const filters: JiraFilters = {
    preset: search.preset ?? "assigned",
    jql: search.jql ?? "",
    projects: search.projects ?? [],
    status: search.status ?? [],
    q: search.q ?? "",
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1">
        <div
          {...workspaceAreaProps("jira", 1, "Jira issues")}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col bg-background",
            selected !== undefined && "max-md:hidden",
          )}
        >
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls={selected === undefined}
            className="relative bg-background"
          >
            <WorkspaceBreadcrumb ariaLabel="Jira breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Jira</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="min-w-0 flex-1" />
            {configured.length > 1 ? (
              <Select
                value={environmentId}
                onValueChange={(value) =>
                  onSearch({ environmentId: value as EnvironmentId, issue: undefined })
                }
              >
                <SelectTrigger size="sm" className="w-44" aria-label="Jira environment">
                  <SelectValue>
                    {(value: string | null) =>
                      environments.find((environment) => environment.environmentId === value)
                        ?.label ?? ""
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {configured.map((id) => (
                    <SelectItem key={id} hideIndicator value={id}>
                      {environments.find((environment) => environment.environmentId === id)
                        ?.label ?? id}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh issues"
              disabled={view.pending}
              onClick={() => refreshJira(environmentId)}
            >
              <RefreshIcon size="md" refreshing={view.pending} />
            </Button>
          </WorkspacePageHeader>
          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
              <JiraFilterBar
                filters={filters}
                projects={projects.data?.projects ?? []}
                busy={view.pending && view.issues.length > 0}
                onChange={(patch) =>
                  onSearch({
                    ...(patch.preset === undefined ? {} : { preset: patch.preset }),
                    ...(patch.jql === undefined ? {} : { jql: patch.jql }),
                    ...(patch.projects === undefined ? {} : { projects: patch.projects }),
                    ...(patch.status === undefined ? {} : { status: patch.status }),
                    ...(patch.q === undefined ? {} : { q: patch.q }),
                  })
                }
              />
              {view.issues.length > 0 ? (
                <>
                  <JiraIssueList
                    groups={groups}
                    selectedKey={selected}
                    linkedThreads={linked}
                    onSelect={(key) => onSearch({ issue: key })}
                  />
                  {view.failure !== null ? (
                    <p className="text-destructive text-sm">
                      {formatEnvironmentQueryError(view.failure)}
                    </p>
                  ) : null}
                  {view.hasMore ? (
                    <div className="flex justify-center">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={view.pending}
                        onClick={() => setPaging({ inputKey, pages: pages + 1 })}
                      >
                        {view.pending ? "Loading..." : "Show more"}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : view.failure !== null ? (
                <Empty>
                  <EmptyMedia variant="icon">
                    <SearchXIcon />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>Could not load issues</EmptyTitle>
                    <EmptyDescription>{formatEnvironmentQueryError(view.failure)}</EmptyDescription>
                  </EmptyHeader>
                  <Button size="sm" variant="outline" onClick={() => refreshJira(environmentId)}>
                    Try again
                  </Button>
                </Empty>
              ) : view.pending ? (
                <ListSkeleton />
              ) : (
                <Empty>
                  <EmptyMedia variant="icon">
                    <SquareKanbanIcon />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>No issues here</EmptyTitle>
                    <EmptyDescription>
                      {view.jql === null
                        ? "Nothing matches these filters."
                        : `Nothing matches ${view.jql}`}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </WorkspacePageContainer>
          </div>
        </div>
        {selected === undefined ? null : (
          <JiraIssuePanel
            key={selected}
            environmentId={environmentId}
            issueKey={selected}
            listed={view.issues.find((issue) => issue.key === selected)}
            linked={linked.get(selected) ?? []}
            onClose={() => onSearch({ issue: undefined })}
          />
        )}
      </div>
    </SidebarInset>
  );
}

export function JiraPage() {
  const search = useSearch({ from: "/_chat/jira" });
  const navigate = useNavigate();
  const configured = useAtomValue(jiraConfiguredEnvironmentIdsAtom);
  const fallback = useJiraEnvironmentId();
  const environmentId =
    search.environmentId !== undefined && configured.includes(search.environmentId)
      ? search.environmentId
      : fallback;
  if (environmentId === null) return <JiraNotSetUp />;
  return (
    <JiraWorkspace
      key={environmentId}
      environmentId={environmentId}
      search={search}
      onSearch={(patch) =>
        void navigate({ to: "/jira", search: applyJiraSearchPatch(search, patch), replace: true })
      }
    />
  );
}
