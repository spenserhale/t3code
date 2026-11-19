import { useCompareEnvironments, useCopySettings } from "../settings/useSettingsCopy";
import {
  type CompareEnvironment,
  type CompareItem,
  compareItemLabel,
  missingSliderItem,
} from "../settings/settingsCompare.logic";
import { Button } from "../ui/button";
import type { EffortSliderActions } from "./useComposerEffortSlider";

function CopyHintRow(props: {
  source: CompareEnvironment;
  destination: CompareEnvironment;
  item: CompareItem;
}) {
  const copySettings = useCopySettings();
  const label = compareItemLabel(props.item);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {props.source.label} has {/^[aeiou]/i.test(label) ? "an" : "a"} {label}.
      </span>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => copySettings(props.source, [props.destination], [props.item])}
      >
        Copy it to {props.destination.label}
      </Button>
    </div>
  );
}

/**
 * Where a tab shows no slider here but the primary environment keeps one for it, offers to copy
 * that slider, so a machine that missed a save does not silently lose it.
 */
export function EffortSliderCopyHint({
  target,
}: {
  target: EffortSliderActions["settingsTarget"];
}) {
  const { connected, primaryEnvironmentId } = useCompareEnvironments();
  if (target.projectOverrides || target.environmentId === primaryEnvironmentId) return null;
  const source = connected.find(
    (environment) => environment.environmentId === primaryEnvironmentId,
  );
  const destination = connected.find(
    (environment) => environment.environmentId === target.environmentId,
  );
  const item = source && destination ? missingSliderItem(source, destination, target.driver) : null;
  return source && destination && item ? (
    <CopyHintRow source={source} destination={destination} item={item} />
  ) : null;
}
