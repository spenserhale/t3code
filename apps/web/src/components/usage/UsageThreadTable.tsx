import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, UsageSummaryInput } from "@t3tools/contracts";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { useThreadUsageTotals } from "../../state/threadUsage";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  isThreadCostUnknown,
  nextThreadSort,
  sortThreadRows,
  type ThreadSort,
  type ThreadSortKey,
  type ThreadUsageRow,
} from "./usageThreads";

const COLUMNS: readonly { readonly key: ThreadSortKey; readonly label: string }[] = [
  { key: "thread", label: "Thread" },
  { key: "cost", label: "Cost" },
  { key: "turns", label: "Turns" },
  { key: "tokens", label: "Tokens" },
];

/**
 * Usage per thread for the page's window. Rows open their thread. Totals cover
 * the main agent's turns driven through T3 Code, so they do not add up to the
 * model breakdown.
 */
export function UsageThreadTable({
  window,
  selectedEnvironmentIds,
  metric,
  refreshCount,
}: {
  readonly window: UsageSummaryInput;
  /** `null` selects every environment, as on the rest of the page. */
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly metric: "cost" | "tokens";
  /** Goes up each time the page is refreshed by hand; the totals are then read again. */
  readonly refreshCount: number;
}) {
  const usage = useThreadUsageTotals(window, selectedEnvironmentIds);
  const { threads, unsupportedEnvironments, failedEnvironments } = usage;
  const refreshUsage = useEffectEvent(() => usage.refresh());
  // Mounting already reads the totals; only a later refresh needs to ask again.
  const seenRefreshCount = useRef(refreshCount);
  useEffect(() => {
    if (seenRefreshCount.current === refreshCount) return;
    seenRefreshCount.current = refreshCount;
    refreshUsage();
  }, [refreshCount]);
  const navigate = useNavigate();
  const shells = useThreadShells();
  const projects = useProjects();
  const [sort, setSort] = useState<ThreadSort>({ key: metric, direction: "desc" });

  const rows = useMemo(() => {
    const key = (environmentId: EnvironmentId, id: string) => `${environmentId}:${id}`;
    const shellByKey = new Map(shells.map((shell) => [key(shell.environmentId, shell.id), shell]));
    const projectByKey = new Map(
      projects.map((project) => [key(project.environmentId, project.id), project.title]),
    );
    return sortThreadRows(
      threads.map((thread): ThreadUsageRow & { readonly project: string | null } => {
        const shell = shellByKey.get(key(thread.environmentId, thread.threadId));
        return {
          ...thread,
          title: shell?.title ?? null,
          project: shell
            ? (projectByKey.get(key(shell.environmentId, shell.projectId)) ?? null)
            : null,
        };
      }),
      sort,
    );
  }, [projects, shells, sort, threads]);

  return (
    <>
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-2/5" />
          <col className="w-1/5" />
          <col className="w-1/5" />
          <col className="w-1/5" />
        </colgroup>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              const SortIcon = sort.direction === "asc" ? ChevronUpIcon : ChevronDownIcon;
              return (
                <th
                  key={column.key}
                  aria-sort={
                    active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
                  }
                  className={cn("py-2 font-normal", column.key !== "thread" && "text-right")}
                >
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground",
                      active && "text-foreground",
                    )}
                    onClick={() => setSort((current) => nextThreadSort(current, column.key))}
                  >
                    {column.label}
                    <SortIcon aria-hidden className={cn("size-3", !active && "invisible")} />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-6 text-center text-muted-foreground">
                {usage.isPending ? "Reading thread usage…" : "No thread activity in this window."}
              </td>
            </tr>
          ) : null}
          {rows.map((row) => (
            <tr
              key={`${row.environmentId}:${row.threadId}`}
              className="border-b border-border/50 transition-colors hover:bg-muted/50"
            >
              <td className="py-2 text-foreground">
                <span className="flex min-w-0 flex-col items-start">
                  {row.title === null ? (
                    <span className="truncate text-muted-foreground">Deleted thread</span>
                  ) : (
                    <button
                      type="button"
                      className="max-w-full truncate rounded-sm text-left hover:underline"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(row.environmentId, row.threadId),
                          ),
                        })
                      }
                    >
                      {row.title}
                    </button>
                  )}
                  <span className="max-w-full truncate text-xs text-muted-foreground">
                    {[row.project, ...row.models].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </td>
              <td className="py-2 text-right text-foreground tabular-nums">
                {isThreadCostUnknown(row) ? (
                  <span className="text-muted-foreground">Unpriced</span>
                ) : (
                  formatUsd(row.costUsd)
                )}
              </td>
              <td className="py-2 text-right text-muted-foreground tabular-nums">
                {formatCount(row.turns)}
              </td>
              <td className="py-2 text-right text-muted-foreground tabular-nums">
                {formatTokens(row.totalTokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Turns run from this app, counting the main agent. Subagents and work done outside it are
        only in the model breakdown.
        {unsupportedEnvironments.length > 0
          ? ` Not reported by ${unsupportedEnvironments.join(", ")}.`
          : ""}
        {failedEnvironments.length > 0
          ? ` Could not be read from ${failedEnvironments.join(", ")}.`
          : ""}
      </p>
    </>
  );
}
