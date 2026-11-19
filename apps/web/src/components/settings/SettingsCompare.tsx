import type { EnvironmentId } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type CompareEnvironment,
  type CompareItem,
  compareItemKey,
  type CompareSummary,
  compareWithSource,
  describeDifferences,
  type ItemComparison,
  listLabels,
} from "./settingsCompare.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { useCompareEnvironments, useCopySettings } from "./useSettingsCopy";

/** A list's size, with each entry's model and effort on hover. */
function SummaryText({ summary }: { summary: CompareSummary }) {
  if (!summary.detail) return <span className="text-xs text-muted-foreground">{summary.text}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-xs text-muted-foreground" />}>
        {summary.text}
      </TooltipTrigger>
      <TooltipPopup side="top">{summary.detail}</TooltipPopup>
    </Tooltip>
  );
}

function copyableDestinations(comparison: ItemComparison) {
  return comparison.differing
    .filter((row) => row.blockedReason === null)
    .map((row) => row.environment);
}

function CompareDialogBody(props: {
  connected: readonly CompareEnvironment[];
  offline: readonly string[];
  initialSourceId: EnvironmentId;
}) {
  const [sourceId, setSourceId] = useState(props.initialSourceId);
  const copySettings = useCopySettings();
  const source =
    props.connected.find((environment) => environment.environmentId === sourceId) ??
    props.connected[0];
  if (!source) return null;
  const comparisons = compareWithSource(
    source,
    props.connected.filter((environment) => environment.environmentId !== source.environmentId),
  );
  const differing = comparisons.filter((comparison) => comparison.differing.length > 0);
  const matching = comparisons.filter((comparison) => comparison.differing.length === 0);
  const destinations = [...new Set(differing.flatMap(copyableDestinations))];
  const copy = (items: readonly CompareItem[], to: readonly CompareEnvironment[]) =>
    copySettings(source, to, items);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Compare environments</DialogTitle>
        <DialogDescription>
          Favorites and effort sliders on each connected environment, compared with one source.
          Copying replaces the destination&apos;s list.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Source</span>
            <Select
              value={source.environmentId}
              onValueChange={(value) => {
                const next = props.connected.find(
                  (environment) => environment.environmentId === value,
                );
                if (next) setSourceId(next.environmentId);
              }}
            >
              <SelectTrigger size="sm" aria-label="Source environment">
                <SelectValue>{source.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {props.connected.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {differing.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every connected environment matches {source.label}.
            </p>
          ) : (
            differing.map((comparison) => {
              const copyable = copyableDestinations(comparison);
              return (
                <div
                  key={compareItemKey(comparison.item)}
                  role="group"
                  aria-label={comparison.label}
                  className="space-y-1.5"
                >
                  <div className="flex min-h-6 items-center justify-between gap-2">
                    <h3 className="text-sm font-medium text-foreground">{comparison.label}</h3>
                    {copyable.length >= 2 ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => copy([comparison.item], copyable)}
                      >
                        Copy to all
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {source.label}: <SummaryText summary={comparison.source} />
                  </p>
                  <ul className="space-y-1">
                    {comparison.differing.map((row) => (
                      <li
                        key={row.environment.environmentId}
                        className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">{row.environment.label}</span>
                        <SummaryText summary={row.summary} />
                        {row.blockedReason === null ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => copy([comparison.item], [row.environment])}
                          >
                            Copy to {row.environment.label}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{row.blockedReason}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {comparison.same.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Same on {listLabels(comparison.same.map((environment) => environment.label))}.
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
          {differing.length > 0 && matching.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Same everywhere: {matching.map((comparison) => comparison.label).join(", ")}.
            </p>
          ) : null}
          {props.offline.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {listLabels(props.offline)} {props.offline.length === 1 ? "is" : "are"} offline, so{" "}
              {props.offline.length === 1 ? "it was" : "they were"} not compared.
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="outline"
          disabled={destinations.length === 0}
          onClick={() =>
            copy(
              differing.map((comparison) => comparison.item),
              destinations,
            )
          }
        >
          Copy all from {source.label}
        </Button>
        <DialogClose render={<Button />}>Done</DialogClose>
      </DialogFooter>
    </>
  );
}

/**
 * Says which environments keep different favorites or sliders than the primary one, whatever
 * the Settings selection, and opens a side-by-side comparison that copies lists between them.
 */
export function SettingsCompareBanner() {
  const { scope } = useSettingsScope();
  const { connected, offline, defaultSource } = useCompareEnvironments();
  const [open, setOpen] = useState(false);
  const environmentWide =
    scope.kind === "all" || scope.kind === "environment" || scope.kind === "environments";
  const message =
    defaultSource && environmentWide
      ? describeDifferences(
          defaultSource,
          connected.filter(
            (environment) => environment.environmentId !== defaultSource.environmentId,
          ),
        )
      : null;
  if (!defaultSource) return null;
  return (
    <>
      {message ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
          <p className="min-w-0 flex-1">{message}</p>
          <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
            Compare
          </Button>
        </div>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="w-full sm:w-[36rem]">
          {/* The popup mounts per open, so the source starts at the primary environment. */}
          <CompareDialogBody
            connected={connected}
            offline={offline}
            initialSourceId={defaultSource.environmentId}
          />
        </DialogPopup>
      </Dialog>
    </>
  );
}
