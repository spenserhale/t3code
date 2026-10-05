/**
 * Tokens and estimated cost beside a thread and its turns. Everything here
 * renders nothing unless the Usage and cost setting is on and the thread's
 * server reports usage.
 */
import type { RunId, ScopedThreadRef, ThreadTurnUsage } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { HexagonIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useThreadUsage, useUsageCostAnalysisSetting } from "../../state/threadUsage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ESTIMATE_NOTE,
  SUBAGENT_NOTE,
  formatEstimatedUsd,
  modelPriceSource,
  threadUsageFigures,
  turnUsageFigures,
  unpricedModels,
  type UsageFigures,
} from "./threadUsageFormat";

/** The token unit, the way `$` is the dollar unit. */
function TokenIcon({ className }: { className?: string }) {
  return <HexagonIcon aria-label="tokens" className={cn("inline size-3 shrink-0", className)} />;
}

function Figures({ figures }: { figures: UsageFigures }) {
  return (
    <span className="inline-flex items-center gap-0.5 tabular-nums">
      <TokenIcon />
      {figures.tokens}
      {figures.cost === null ? null : <>, {figures.cost}*</>}
    </span>
  );
}

function TurnUsageBreakdown({ turn }: { turn: ThreadTurnUsage }) {
  const missing = unpricedModels(turn);
  return (
    <div className="flex max-w-80 flex-col gap-1.5 py-0.5">
      <table className="text-left tabular-nums">
        <tbody>
          {turn.models.map((model) => (
            <tr key={model.model}>
              <td className="max-w-36 truncate pe-3 font-medium">
                {model.model || "Unknown model"}
              </td>
              <td className="pe-3 text-end">
                <span className="inline-flex items-center gap-0.5">
                  <TokenIcon />
                  {formatTokens(model.totalTokens)}
                </span>
              </td>
              <td className="pe-3 text-end">
                {model.costSource === "unpriced" ? "–" : formatEstimatedUsd(model.costUsd)}
              </td>
              <td className="text-muted-foreground">{modelPriceSource(model)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {missing.length > 0 ? (
        <p className="text-muted-foreground">
          Add a price for {missing.join(", ")} on the Usage page, under Model prices, to include it.
        </p>
      ) : null}
      {turn.hasSubagents ? <p className="text-muted-foreground">{SUBAGENT_NOTE}</p> : null}
      <p className="text-muted-foreground">{ESTIMATE_NOTE}</p>
    </div>
  );
}

interface TurnUsageSummaryProps {
  readonly threadRef: ScopedThreadRef | null;
  readonly runId: RunId;
}

/**
 * ` using ⬡ 264K, $0.14*` after a turn's "Worked for" label, with the
 * per-model breakdown on hover.
 */
export function TurnUsageSummary(props: TurnUsageSummaryProps) {
  // Off by default, when a row should cost no more than reading the setting.
  return useUsageCostAnalysisSetting() ? <EnabledTurnUsageSummary {...props} /> : null;
}

function EnabledTurnUsageSummary({ threadRef, runId }: TurnUsageSummaryProps) {
  const turn = useThreadUsage(threadRef)?.turns.get(runId);
  if (!turn) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help" />}>
        using <Figures figures={turnUsageFigures(turn)} />
      </TooltipTrigger>
      <TooltipPopup side="top" align="start">
        <TurnUsageBreakdown turn={turn} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** A row for the sidebar's thread hover card. Mount it only while the card is open. */
export function ThreadUsageHoverRow(props: { readonly threadRef: ScopedThreadRef }) {
  return useUsageCostAnalysisSetting() ? <EnabledThreadUsageHoverRow {...props} /> : null;
}

function EnabledThreadUsageHoverRow({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const usage = useThreadUsage(threadRef);
  if (!usage) return null;
  const figures = threadUsageFigures(usage.totals);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TokenIcon className="stroke-muted-foreground" />
      <div className="min-w-0 truncate text-foreground/75 tabular-nums">
        {figures.tokens}
        {figures.cost === null ? " · no price" : ` · ${figures.cost}*`}
        <span className="text-muted-foreground"> estimated</span>
      </div>
    </div>
  );
}
